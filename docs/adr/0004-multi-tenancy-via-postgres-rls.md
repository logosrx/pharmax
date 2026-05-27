# 0004 — Multi-tenancy via Postgres Row-Level Security with session-GUC enforcement

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** security, tenancy, data

## Context

Pharmax serves multiple pharmacy organizations from one database (see
ADR 0003). Cross-tenant data leakage — clinic A reading clinic B's
orders, patients, or PHI — is a critical incident under HIPAA and a
trust-killer for the product. The standard guidance from
`.cursor/rules/02-security-compliance.mdc` is unambiguous: every
tenant-sensitive query must include the organization scope, and
cross-clinic data leakage is treated as a P0.

Application-layer scoping alone is insufficient. It depends on every
query going through a layer that remembers to add
`where: { organizationId }`. A raw Prisma client in a future PR, a
forgotten `findFirst` in a script, or a Stripe webhook handler that
runs without a tenant context can silently bypass the entire isolation
story. We need a wall that **the database itself** enforces, so a
bypass requires intent.

We also need a clean bootstrap path for system tasks — webhook
ingestion, worker drains, bootstrap CLIs — that legitimately need to
operate before a tenant context exists.

## Decision

Enforce tenancy at **two layers**:

1. **Postgres Row-Level Security (RLS)** is the wall. Migration
   `20260522060000_rls_baseline` creates two database roles
   (`pharmax_app` — subject to RLS for normal runtime;
   `pharmax_system` — `BYPASSRLS` for the bootstrap path), enables
   **AND forces** RLS on every tenant-scoped table (`FORCE` means even
   the table owner is policy-checked), and installs one
   `tenant_isolation` policy per table whose predicate is
   `current_setting('pharmax.system_context', true) = 'on' OR <tenant>`.
   The tenant clause is `id = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid`
   for `organization` and `"organizationId" = ...` for every other
   tenant-scoped table. `NULLIF` collapses the empty-string GUC clear
   into a SQL NULL so an unset GUC fails the predicate — **fail-closed**.
2. **Application-layer tenancy context** in `@pharmax/tenancy` carries
   the `{organizationId, actor, correlationId}` frame via Node's
   `AsyncLocalStorage`. A Prisma `$extends` middleware throws
   `AuthorizationError(TENANCY_NO_CONTEXT)` on any tenant-scoped query
   that runs without an active frame, passes through under
   `withSystemContext`, auto-injects `organizationId` into
   `where`/`data`/`upsert.create`, and throws `TENANCY_CROSS_ORG_WRITE`
   on a mismatched write. This is the **fast-fail layer** so
   misconfigured callers see a clear error before they ever reach the
   DB role check.

The session GUCs (`pharmax.system_context`, `pharmax.organization_id`)
are written by `applyTenancySessionGuc` and `applySystemSessionGuc`
in `@pharmax/tenancy`. Per ADR 0007, the command bus invokes one of
these as the **first statement inside every transaction**, with the
GUC value passed as a bound parameter (no string interpolation, no
injection surface).

A migration linter (`scripts/check-migration-rls.ts`) walks every
migration in apply order and rejects any `CREATE TABLE` not paired
with `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY`. Exemptions live
in `prisma/migrations/rls-exempt.txt` and require a documented
architectural justification (currently `permission`, `role_permission`,
`clinic_site`, `stripe_webhook_event`).

## Consequences

**Easier:**

- A new tenant-scoped table cannot land without RLS — the migration
  linter fails CI.
- A query without tenancy context throws fast, with PHI-free error
  metadata, at the application layer; even if that guard is bypassed,
  the DB role check fires.
- Auditors get a one-line answer to "how do you prevent cross-tenant
  data access?" — Postgres RLS, forced, fail-closed on unset GUCs.

**Harder:**

- Every transaction must set the GUC as its first statement. The
  command bus and the worker's drainer both shoulder this; ad-hoc
  scripts must use `withSystemContext` or `withTenancyContext`.
- `audit_log` and `verification_record` are policy-immutable: they
  carry only `SELECT` and `INSERT` policies, and `UPDATE`/`DELETE` are
  additionally `REVOKE`d. This is a feature, but it surprises new
  contributors expecting standard CRUD.
- The system context is a dangerous privilege. `withSystemContext` is
  ESLint-allowlisted to four locations: the definition site, the bus's
  `executeSystemCommand`, the `scripts/` directory, and `*.test.ts`
  fixtures. Application code goes through a command handler.

**Ongoing obligations:**

- New tables either get RLS or get added to `rls-exempt.txt` with
  justification.
- The cross-org anti-leak property test in `@pharmax/tenancy` runs
  100 parallel queries across two orgs through a fake DB; it stays
  green on every change to the extension.

## References

- ADR 0003 — PostgreSQL + Prisma as the transactional source of truth
- ADR 0007 — Twenty-step command-bus contract (GUC ordering inside the tx)
- `prisma/migrations/20260522060000_rls_baseline/`
- `packages/tenancy/src/` — `AsyncLocalStorage` context, session-GUC writers
- `scripts/check-migration-rls.ts` — migration linter
- `docs/ARCHITECTURE_PRINCIPLES.md` §B.1, §C.1
