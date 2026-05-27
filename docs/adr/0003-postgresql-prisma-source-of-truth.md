# 0003 — PostgreSQL + Prisma as the transactional source of truth

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** data, persistence

## Context

Every command in Pharmax — workflow transitions, PHI writes, billing
materializations, idempotency lookups, audit chain entries — needs to
land **atomically**. A workflow command must update the order, write
the structured domain record (e.g. `verification_record`), append the
audit hash-chain entry, enqueue the outbox event, and stamp the
idempotency key in a single, transactional write. Anything weaker and
the order can ship without a verification on file, or be billed twice,
or leak a "successful" outcome to an operator while the audit row is
missing.

We also need:

- Foreign keys and `ON DELETE RESTRICT` so the audit trail's anchors
  cannot vanish.
- Row-level isolation (multi-tenancy), which we enforce via Postgres
  RLS (see ADR 0004).
- Strong typing across the schema-to-application boundary so
  workflow safety doesn't depend on developers remembering to spell
  column names correctly.

## Decision

Adopt **PostgreSQL** as the single transactional source of truth and
**Prisma** as the ORM and migration tool.

- One Postgres database holds every business table: tenancy core,
  identity/RBAC, workflow primitives, PHI tables, audit chain,
  billing, shipping, print/scan.
- All schema changes flow through `prisma migrate` and are stored as
  versioned SQL under `prisma/migrations/`. Migrations are reviewed
  the same way as code.
- The generated Prisma client is private to `@pharmax/database`. Every
  other workspace package imports the singleton and types from
  `@pharmax/database`; ESLint enforces this with a `no-restricted-imports`
  rule that bans `@prisma/client` everywhere except inside the
  `packages/database/**` override.
- Critical mutations use `prisma.$transaction` with row locks
  (`SELECT … FOR UPDATE`) on the aggregate root. The twenty-step
  command bus (ADR 0007) is built around this primitive.
- Raw SQL is used freely when Prisma's query builder is the wrong
  shape (RLS GUC writes, audit chain `pg_advisory_xact_lock`,
  `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` for queue claims).

## Consequences

**Easier:**

- Atomicity across the four audit primitives (`command_log`,
  `order_event`, `audit_log`, `event_outbox`) is a property of
  Postgres, not of application code.
- Postgres-native features we lean on heavily — RLS for tenancy,
  advisory locks for serialization, `JSONB` for envelope ciphertext,
  partial unique indexes for "only one active hold per order" —
  collapse design problems into schema constraints.
- The Prisma DMMF is machine-readable: schema linters
  (`scripts/check-prisma-schema.ts`) and the tenancy registry
  (`TENANT_SCOPED_MODELS`) walk it to catch a new model that hasn't
  been classified for tenancy.

**Harder:**

- Heavy analytics on the transactional database is contraindicated.
  We accept this and plan for read replicas and reporting routing
  in Phase 6.
- Prisma's `$extends` middleware (the tenancy enforcement layer) is
  a hot path; we measure it and keep it minimal.
- Prisma occasionally fights schema realities we need (e.g. partial
  unique indexes for "one active hold per order" must be added as raw
  SQL in the migration; the Prisma schema cannot express them). We
  accept this and pay the operational tax.

**Ongoing obligations:**

- Every new tenant-scoped model must be added to `TENANT_SCOPED_MODELS`
  in `@pharmax/tenancy`; the parity test fails the build otherwise.
- Every new `CREATE TABLE` must be paired with the standard RLS
  policy from ADR 0004 (the migration linter enforces this).
- Migrations are forward-only in production; rollbacks are forward
  migrations that undo the previous change.

## Alternatives Considered

- **DynamoDB or another NoSQL store.** Loses transactional atomicity
  across the four audit primitives. The audit chain alone makes this
  a non-starter.
- **Multiple databases per domain.** Reintroduces the distributed-
  transaction problem that ADR 0002 explicitly avoided.
- **Drizzle or Kysely instead of Prisma.** Stronger SQL ergonomics
  but weaker generated-type story and no equivalent of `$extends`
  middleware. Prisma's DMMF is what makes the schema-linter pattern
  cheap; we keep Prisma and use raw SQL when its query builder is
  the wrong shape.

## References

- ADR 0002 — Modular monolith with event-driven internals
- ADR 0004 — Multi-tenancy via Postgres RLS
- ADR 0006 — Hash-chained audit log with TLV canonical encoding
- ADR 0007 — Twenty-step command-bus contract
- `packages/database/` — Prisma client singleton, generated types
- `prisma/schema.prisma`, `prisma/migrations/`
- `eslint.config.js` — `no-restricted-imports` ban on `@prisma/client`
