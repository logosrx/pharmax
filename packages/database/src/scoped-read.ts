// readInTenantContext — both-layers tenant-scoped read wrapper.
//
// Read helpers historically wrapped their queries in
// `withTenancyContext(ctx, () => prisma.x.findMany(...))`. With the
// tenancy extension now applied to the canonical client, that already
// gets ORM-layer scoping. This helper adds the SECOND layer for
// reads: it opens an interactive transaction and sets the Postgres
// session GUC (`applyTenancySessionGuc`) so Row-Level Security ALSO
// enforces `organizationId = <tenant>` for every query inside `fn` —
// the same backstop the command bus gives writes.
//
// Use it for any read path that must be defense-in-depth (operator
// list/detail pages, report reads, billing reads). Queries inside
// `fn` MUST use the provided `tx` client, not the module-level
// `prisma`, so they run on the connection that holds the GUC.
//
//   await readInTenantContext(ctx, async (tx) => {
//     return tx.reportSchedule.findMany({ select: { ... } });
//   });
//
// Notes:
//   - `fn` runs inside `withTenancyContext`, so the extension's
//     ORM-layer org filter is active too. Both layers agree.
//   - The transaction is read-shaped; keep `fn` free of long-running
//     work so the connection is not held open.
//   - RLS only actually engages when the app connects as a non-
//     BYPASSRLS role (`pharmax_app`). Under a superuser dev
//     connection the GUC is set but ignored — harmless, and the ORM
//     layer still enforces isolation.

import { ids } from "@pharmax/platform-core";
import {
  applySystemSessionGuc,
  applyTenancySessionGuc,
  buildTenancyContext,
  withSystemContext,
  withTenancyContext,
  type SessionGucExecutor,
  type TenancyContext,
} from "@pharmax/tenancy";

import { prisma } from "./scoped-client.js";
import type { PrismaClient } from "./generated/client/index.js";

// Sentinel actor for server-side READ scopes that have authenticated
// the operator and resolved their org, but do not have (or need) the
// full command actor. Read projections never write command_log /
// audit_log / event_outbox, so the actor is never persisted — both
// enforcement layers (the tenancy extension and the RLS GUC) read
// only `organizationId`. Using a sentinel keeps the read helpers'
// `{ organizationId }` signatures stable while still establishing a
// real tenancy frame. NEVER perform a mutating command inside a
// read scope — route those through the command bus with the real
// operator context instead.
const READ_SCOPE_SENTINEL_USER_ID = "00000000-0000-0000-0000-000000000000";

export function buildReadScopeContext(organizationId: string): TenancyContext {
  return buildTenancyContext({
    organizationId,
    actor: { userId: READ_SCOPE_SENTINEL_USER_ID, correlationId: ids.generateUlid() },
  });
}

/**
 * The interactive-transaction client shape Prisma passes to the
 * `$transaction(async (tx) => ...)` callback. It exposes every model
 * delegate the full client does, minus the top-level lifecycle
 * methods (`$connect`, `$transaction`, etc.).
 */
export type TenantTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Run `fn` inside a tenant-scoped transaction with BOTH the ALS
 * tenancy frame (ORM-layer extension) and the RLS session GUC
 * (DB-layer) active. Queries inside `fn` must use the provided `tx`.
 */
export function readInTenantContext<T>(
  ctx: TenancyContext,
  fn: (tx: TenantTransactionClient) => Promise<T>
): Promise<T> {
  return withTenancyContext(ctx, () =>
    prisma.$transaction(async (tx) => {
      await applyTenancySessionGuc(tx as unknown as SessionGucExecutor, ctx);
      return fn(tx as unknown as TenantTransactionClient);
    })
  );
}

/**
 * Both-layers read scope keyed by `organizationId` (for read helpers
 * that take a bare org id rather than a full `TenancyContext`). Opens
 * a transaction, sets the RLS GUC, and runs `fn` with a tenant-scoped
 * `tx` client inside the tenancy frame.
 *
 * Queries inside `fn` MUST use the provided `tx`. Because this opens
 * an interactive transaction, do NOT perform slow non-DB work (e.g.
 * KMS decryption) inside `fn` — that would hold the connection. For
 * read flows that interleave KMS/HTTP work, split into "load rows in
 * `readInOrgScope` (tx) → process after the tx closes".
 */
export function readInOrgScope<T>(
  organizationId: string,
  fn: (tx: TenantTransactionClient) => Promise<T>
): Promise<T> {
  return readInTenantContext(buildReadScopeContext(organizationId), fn);
}

/**
 * SYSTEM-context read wrapper. Establishes the ALS system frame (the
 * tenancy extension passes queries through unscoped) AND sets the
 * Postgres `pharmax.system_context = 'on'` GUC so RLS permits
 * cross-tenant reads on the connection.
 *
 * This is the read-side analogue of the command bus's system-command
 * path. Use it for the narrow set of supervisor reads that resolve a
 * tenant from an EXTERNAL identifier before a tenancy frame exists —
 * RBAC permission loading, operator role-code lookup, Clerk-session →
 * Pharmax-user resolution, and inbound-webhook tenant resolution.
 * Without the GUC these reads fail closed under the non-BYPASSRLS
 * `pharmax_app` runtime role.
 *
 * Callers MUST still scope by an explicit `WHERE` (e.g. the external
 * id) — `system_context` only lifts the RLS predicate; it does not
 * choose rows. `reason` is recorded in `pharmax.system_context_reason`
 * for the audit channel.
 */
export function readInSystemContext<T>(
  reason: string,
  fn: (tx: TenantTransactionClient) => Promise<T>
): Promise<T> {
  return withSystemContext(reason, () =>
    prisma.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, reason);
      return fn(tx as unknown as TenantTransactionClient);
    })
  );
}
