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

import {
  applyTenancySessionGuc,
  withTenancyContext,
  type SessionGucExecutor,
  type TenancyContext,
} from "@pharmax/tenancy";

import { prisma } from "./scoped-client.js";
import type { PrismaClient } from "./generated/client/index.js";

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
