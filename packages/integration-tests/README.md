# @pharmax/integration-tests

DB-bound integration tests that run against a real Postgres
(the docker-compose `postgres` service in this repo).

These tests verify what the fake-Prisma unit tests structurally
cannot:

- That the **RLS policies** actually block cross-tenant reads
  under the runtime `pharmax_app` role.
- That the **GRANTs** actually deny `UPDATE` / `DELETE` on
  append-only tables (`audit_log`, `verification_record`).
- That the **CHECK constraints** actually fire (e.g.
  `verification_record_rejection_reason_required`).
- That `SELECT ... FOR UPDATE` actually serializes concurrent
  CAS attempts on the same order row.
- That the audit chain `prev_hash → entry_hash` links are
  byte-correct across two sequential commands in one tenant.

## Why a separate runner

The default `pnpm test` runs entirely on fake Prisma — no DB
dependency, fast feedback, runs in any environment including CI
without Docker. These tests are **excluded** from the default
runner (`vitest.config.ts` excludes `packages/integration-tests/**`)
so contributors who haven't started the local DB still get useful
unit-test feedback.

Run them deliberately with:

```bash
pnpm db:up                   # start docker-compose postgres
pnpm db:migrate:deploy       # apply the schema
pnpm test:integration        # run this package's tests
```

## Environment

The tests honor (in order):

1. `INTEGRATION_DATABASE_URL` — use this to point at a separate
   database from your dev DB. Recommended for any dev who actively
   writes to the local `pharmax` DB.
2. `DATABASE_URL` — falls through to your dev DB. Each test
   seeds its own org with a randomized slug and cleans up after
   itself, so concurrent dev work shouldn't be disturbed in
   practice.

The tests run **sequentially** (`pool: forks, singleFork: true`)
because they set session-level GUCs (`pharmax.organization_id`,
`pharmax.system_context`) that would race under parallel
execution.

## Test surface

| Test file                     | What it pins                                                            |
| ----------------------------- | ----------------------------------------------------------------------- |
| `verification-record.test.ts` | RLS isolation, `REVOKE UPDATE/DELETE`, and the `decision↔reason` CHECK. |

## Adding a new test

1. Land the schema change + RLS policy + GRANTs in a migration.
2. Add a `*.test.ts` here that:
   - Connects as `owner` (BYPASSRLS) to set up fixtures.
   - Switches to `app` and asserts the user-facing query path
     sees what it should (and doesn't see what it shouldn't).
   - Asserts each constraint by attempting the violation and
     pinning the Postgres SQLSTATE code.
3. Run `pnpm test:integration` locally before merging.
