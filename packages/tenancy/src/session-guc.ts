// Postgres session GUC (Grand Unified Configuration) helpers for the
// RLS baseline.
//
// The RLS policies installed by `20260522060000_rls_baseline` read
// two session variables:
//
//   pharmax.organization_id   uuid; the active tenant for this tx.
//   pharmax.system_context    'on'/unset; the BYPASSRLS override.
//
// These helpers are the ONLY supported way to set those GUCs. The
// command bus calls them as the first statements of every
// transaction, BEFORE the handler runs. This guarantees:
//
//   - In a user (tenant) context, every query inside the tx is
//     subject to a `where organizationId = <tenant>` RLS predicate
//     enforced by Postgres itself, independent of the Prisma
//     extension.
//   - In a system context, the BYPASSRLS sentinel is set so
//     bootstrap commands (CreateOrganization, etc.) can write across
//     orgs — but `audit_log` UPDATE/DELETE remain denied because
//     those are revoked at the role level, not policy level.
//
// Implementation notes:
//
//   - `set_config(name, value, is_local)` is preferred over
//     `SET LOCAL name = value` because Prisma's `$executeRaw` template
//     binds values as parameters. SET LOCAL would require us to
//     interpolate the value into the SQL text (vulnerable to
//     injection if a future caller forgets to validate the input).
//     set_config takes the value as a normal parameter.
//
//   - `is_local = true` scopes the change to the current transaction.
//     When the tx ends, the GUC resets — pool-shared connections do
//     NOT leak tenant context between commands.
//
//   - We call these helpers via Prisma's transaction client (tx),
//     which is guaranteed to use the same connection for the lifetime
//     of the transaction. Outside of a tx the helpers would set the
//     GUC on whatever pool connection the call landed on and lose
//     it on the next checkout. Callers MUST pass a tx client.
//
// Defense in depth:
//
//   - The @pharmax/tenancy Prisma extension auto-injects
//     `where { organizationId }` at the ORM layer.
//   - These helpers add `where organizationId = ...` enforcement at
//     the DATABASE layer (RLS).
//   - Both must agree, or a query that bypasses the extension still
//     gets blocked by the database (and vice versa).

import type { TenancyContext } from "./context.js";

/**
 * Minimal shape of a Prisma transaction client we depend on. Avoids
 * a build-time dependency on @pharmax/database from inside @pharmax/
 * tenancy, which would create a cycle (database depends on tenancy
 * for the extension).
 *
 * `$executeRaw` is Prisma's parameterized raw SQL primitive — it
 * accepts a tagged template and binds the interpolated values as
 * query parameters.
 */
export interface SessionGucExecutor {
  $executeRaw(template: TemplateStringsArray, ...values: ReadonlyArray<unknown>): Promise<number>;
}

/**
 * Set the RLS session variables for a user (tenant) context inside
 * a Prisma transaction. Idempotent — calling it twice in the same
 * tx is a no-op on the second call (Postgres overwrites the same
 * value).
 *
 * @throws Error if `ctx.organizationId` is empty (would silently
 *   allow every query to match the policy because the GUC compares
 *   `<empty>::uuid` which Postgres rejects, but the error message
 *   would be confusing if it bubbled up from inside the policy).
 *   We fail fast with a clear message here.
 */
export async function applyTenancySessionGuc(
  tx: SessionGucExecutor,
  ctx: TenancyContext
): Promise<void> {
  if (typeof ctx.organizationId !== "string" || ctx.organizationId.length === 0) {
    throw new Error(
      "applyTenancySessionGuc: ctx.organizationId is required and must be a non-empty string."
    );
  }
  // Set pharmax.organization_id to the active tenant AND defensively
  // clear any stray system_context bypass left on this pooled
  // connection from a prior tx — in a SINGLE round trip.
  //
  //   - Both GUCs are independent, so evaluating the two set_config
  //     calls in one SELECT target list is equivalent to two separate
  //     statements but costs one network round trip instead of two.
  //     At enterprise read volume this halves the per-read GUC overhead
  //     (every tenant-scoped read opens a tx and runs this first).
  //   - `is_local = true` keeps both values scoped to the current
  //     transaction so nothing leaks to the next checkout of this pool
  //     connection.
  //   - Every value (the org id, the empty string) flows through as a
  //     BOUND PARAMETER, never interpolated into SQL text — the
  //     injection-safety invariant is unchanged.
  //   - The empty system_context evaluates as "not 'on'", so the RLS
  //     predicate denies the bypass.
  const empty = "";
  await tx.$executeRaw`SELECT set_config('pharmax.organization_id', ${ctx.organizationId}, true), set_config('pharmax.system_context', ${empty}, true)`;
}

/**
 * Set the RLS session variables for a system (BYPASSRLS) context
 * inside a Prisma transaction. The `reason` is recorded in
 * `pharmax.system_context_reason` for observability (the RLS
 * policies do not read it; the audit_log writer does).
 */
export async function applySystemSessionGuc(tx: SessionGucExecutor, reason: string): Promise<void> {
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error(
      "applySystemSessionGuc: reason is required and must be a non-empty string (recorded for audit)."
    );
  }
  // Clear any prior tenant pin, set the system_context bypass, and
  // record the reason — in a SINGLE round trip.
  //
  //   - Clearing organization_id to '' makes the NULLIF(...,'')::uuid
  //     expression in the RLS policy evaluate to NULL, so the tenant
  //     predicate is false; the system_context disjunct is what allows
  //     access. Belt-and-braces.
  //   - The three GUCs are independent, so collapsing the three
  //     set_config calls into one SELECT target list is semantically
  //     identical to three statements at a third of the round trips.
  //   - Every value (the empty string, the literal 'on', and the audit
  //     reason) is sent as a BOUND PARAMETER rather than a SQL literal,
  //     to keep the injection-safety invariant uniform across this
  //     module.
  const empty = "";
  const on = "on";
  await tx.$executeRaw`SELECT set_config('pharmax.organization_id', ${empty}, true), set_config('pharmax.system_context', ${on}, true), set_config('pharmax.system_context_reason', ${reason}, true)`;
}

/**
 * Clear both GUCs. Defensive use only — Postgres clears local
 * settings automatically at tx end. Exposed for tests that want to
 * verify the clear-state baseline.
 */
export async function clearSessionGuc(tx: SessionGucExecutor): Promise<void> {
  // Single round trip — the three GUCs are independent, so one SELECT
  // target list clears all of them with the same semantics as three
  // separate statements.
  const empty = "";
  await tx.$executeRaw`SELECT set_config('pharmax.organization_id', ${empty}, true), set_config('pharmax.system_context', ${empty}, true), set_config('pharmax.system_context_reason', ${empty}, true)`;
}
