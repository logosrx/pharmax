# Prisma

Schema-first.

## Status

- Migrations applied:
  - `20260514134704_baseline` — tenancy + RBAC + workflow policy + audit
    primitives + billing tables.
  - `20260522060000_rls_baseline` — `pharmax_app` / `pharmax_system`
    roles, schema/DML grants, RLS enable+force, `tenant_isolation`
    policies for the 18 tenant-scoped tables.
  - `20260522190000_audit_chain` — `audit_log.prevHash`, `entryHash`,
    `seq` columns, `audit_chain_state` table, per-tenant advisory
    lock function.
  - `20260523190000_phase2_patient_rx_order` — `patient`, `provider`,
    `prescription`, `order`, `order_line` tables; promotes the three
    placeholder columns (`command_log.targetOrderId`,
    `order_event.orderId`, `invoice_line.orderId`) to real FKs.
- Generated Prisma client lives at `packages/database/src/generated/client/`
  (gitignored; rebuilt on `pnpm install` via root postinstall).
- `@pharmax/database` package owns the singleton `prisma` client; other
  packages import from `@pharmax/database`, never from `@prisma/client`.
- `prisma/seed.ts` is idempotent and seeds: 19 system permissions,
  6 built-in role templates (cloned for the demo org), one demo
  `Organization` ("acme"), one site, one clinic, one team, the standard
  workflow buckets, one workstation, one invited admin user, and the v1
  `order.standard` workflow policy stub. **No PHI seeds** — the phase-2
  patient/Rx/order tables intentionally start empty.

`schema.prisma` defines the following modules, in load order:

| Section          | Models                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Tenancy core     | `Organization`, `PharmacySite`, `Clinic`, `ClinicSite`, `Team`, `Bucket`, `Workstation`    |
| Identity / RBAC  | `User`, `Role`, `Permission`, `RolePermission`, `UserRole`                                 |
| Workflow policy  | `WorkflowPolicy`                                                                           |
| Audit primitives | `CommandLog`, `OrderEvent`, `AuditLog`, `AuditChainState`, `EventOutbox`, `IdempotencyKey` |
| Billing          | `StripeCustomer`, `StripeWebhookEvent`, `Invoice`, `InvoiceLine`                           |
| Domain entities  | `Patient`, `Provider`, `Prescription`, `Order`, `OrderLine`                                |

### Deferred (NOT in this schema yet)

- `Lot`, `LotHold`, `Product`, `Ndc` — phase 4 (inventory traceability).
  The `order_line.lotId` and `order_line.vialLabelId` columns are
  already shaped as raw `Uuid` placeholders ready to be promoted to
  real foreign keys without renames.
- `VialLabel`, `LabelReprint`, `ScanEvent`, `PrintJob` — phase 4.
- `Shipment`, `ShipmentEvent`, `TrackingWebhookEvent` — phase 4.
- `BillingEvent`, `PriceList`, `Payment`, `Reconciliation` — phase 5.
- `OrderStageInterval`, `EmergencyBucketRule`, `CancellationDispostion` — phase 3.

## Applying the baseline locally

```bash
# 1. Bring up Postgres (Redis, MinIO, etc are optional for the migration).
pnpm db:up

# 2. Copy env template if you don't have a .env yet.
cp .env.example .env

# 3. Apply migrations to your local DB.
pnpm db:migrate:deploy   # CI / staging / prod path
# or
pnpm db:migrate          # dev path; lets you author follow-up migrations

# 4. Seed built-in permissions, roles, and the demo organization.
pnpm db:seed
```

Other useful scripts:

| Script                 | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `pnpm db:generate`     | Regenerate the Prisma client (also runs in `postinstall`)            |
| `pnpm db:reset`        | Drop + recreate the dev database, re-apply migrations (no auto-seed) |
| `pnpm db:studio`       | Launch Prisma Studio against `DATABASE_URL`                          |
| `pnpm prisma:validate` | Schema-only validation, no DB needed (in `pnpm verify`)              |
| `pnpm prisma:format`   | Canonicalize formatting                                              |

## Schema validation

The CI gate `pnpm verify` runs:

```bash
pnpm prisma:validate   # parses + relation-checks the schema
```

`pnpm prisma:format` will canonicalize formatting in place.

Both commands inject placeholder URLs for `DATABASE_URL` / `DIRECT_URL`
because validation does not connect to the database — it only resolves
the datasource block. Real values come from `.env` for any commands
that actually talk to Postgres (`migrate`, `db push`, `db pull`, etc.).

## Conventions

- **Tables** are snake_case via `@@map`.
- **Columns** are camelCase (Prisma default; preserved as quoted
  identifiers by Postgres). A future PR may globalize columns to
  snake_case if raw-SQL ergonomics become an issue; that change requires
  a migration and is deliberately out of scope of the baseline schema.
- **IDs** are `String @id @default(uuid()) @db.Uuid`.
- **Soft deletes** are not used. Status enums (`ACTIVE`, `ARCHIVED`,
  `SUSPENDED`, `TERMINATED`) capture lifecycle state.
- **Tenancy**: every domain row carries `organizationId`. Rows that
  belong to a single clinic also carry `clinicId`. Repository base
  classes in `@pharmax/tenancy` (added later) refuse to issue queries
  without a tenant context.
- **PHI**: confined to the section-8 models (`patient`, `prescription`,
  `order`, `order_line`). Every PHI column is suffixed `*Enc` and stores
  an envelope-encrypted JSONB produced by `@pharmax/crypto::encryptField`
  with AAD bound to `(table, column, recordId)`. Searchable PHI is
  paired with HMAC blind-index `*Bi` columns whose (table, column)
  purposes are registered in
  `packages/database/src/phi/blind-index-purposes.ts`. The `patient`
  row carries a `cryptoShreddedAt` tombstone — when set, the row's
  DEKs have been destroyed at the KMS and the `*Enc` columns are
  permanently unreadable; the row remains for FK integrity only.
- **Auditability**: every domain mutation lands four rows
  (`command_log`, `order_event`, `audit_log`, `event_outbox`) inside one
  transaction. The schema enforces shape; the command bus enforces the
  invariant. Idempotency is enforced by `idempotency_key` and by
  `command_log.organizationId + commandName + idempotencyKey` unique.

## Database roles (RLS baseline)

Migration `20260522060000_rls_baseline` installs the two app roles
that production runs as. **Local dev continues to use the `postgres`
superuser** (which has implicit BYPASSRLS), so no action is needed
until you stand up a non-local environment.

| Role                  | Purpose                                                               | RLS                |
| --------------------- | --------------------------------------------------------------------- | ------------------ |
| `pharmax_app`         | App connections (apps/web, apps/worker, scripts run in user context). | Subject to RLS     |
| `pharmax_system`      | Bootstrap commands (`CreateOrganization`, mass backfills).            | BYPASSRLS          |
| `postgres` / migrator | Owns the schema, runs migrations.                                     | Implicit BYPASSRLS |

The command bus sets two Postgres session GUCs at the start of every
transaction. These power the RLS policies installed by the baseline
migration:

- `pharmax.organization_id` — uuid, the active tenant. Set in
  user-context transactions via `applyTenancySessionGuc(tx, ctx)`.
- `pharmax.system_context` — `'on'` when a system command is
  executing; the RLS policies treat this as the BYPASSRLS sentinel.
  Set via `applySystemSessionGuc(tx, reason)`.

`audit_log` is permanently INSERT/SELECT-only — UPDATE and DELETE
are revoked at the role level for BOTH `pharmax_app` and
`pharmax_system`, AND the table's RLS only defines `FOR INSERT` and
`FOR SELECT` policies (no policy → operation denied). Audit
immutability survives even if a future migration accidentally adds
back the UPDATE/DELETE grant.

### Flipping production from `postgres` to `pharmax_app`

```sql
-- Run once as the superuser after deploying the baseline migration:
ALTER ROLE pharmax_app WITH LOGIN PASSWORD '...';     -- or IAM auth
ALTER ROLE pharmax_system WITH LOGIN PASSWORD '...';
```

Then update the production `DATABASE_URL` to authenticate as
`pharmax_app`. The command bus already sets the GUCs at every tx
boundary, so the switch is transparent to application code.

### Adding a new tenant table

A new tenant-scoped table MUST be paired with `ENABLE ROW LEVEL
SECURITY` + `CREATE POLICY` in the same migration, OR be added to
`prisma/migrations/rls-exempt.txt` with a written justification. The
linter `scripts/check-migration-rls.ts` (wired into `pnpm verify`)
fails the build otherwise.
