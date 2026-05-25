# Runbook

Operational procedures for common incidents and routine maintenance. Each section is a self-contained recipe — copy/paste it and adapt.

> **Before you touch production:** confirm you have approval per [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md). Workflow-state mutations outside the command bus are never the right answer — even in an incident, the command bus is the path.

## Table of contents

1. [Rolling back a deploy](#rolling-back-a-deploy)
2. [Restoring from backup](#restoring-from-backup)
3. [Rotating a KMS data key](#rotating-a-kms-data-key)
4. [Rotating a carrier credential](#rotating-a-carrier-credential)
5. [Replaying a failed Stripe webhook](#replaying-a-failed-stripe-webhook)
6. [Resending a failed print job](#resending-a-failed-print-job)
7. [Audit chain integrity check](#audit-chain-integrity-check)
8. [Outbox drain stuck or backed up](#outbox-drain-stuck-or-backed-up)
9. [SLA breach storm — emergency bucket walkthrough](#sla-breach-storm--emergency-bucket-walkthrough)
10. [Migrations: rules of the road](#migrations-rules-of-the-road)

---

## Rolling back a deploy

**When:** a release introduces a regression that's worse than the bug it fixed.

**Forward-only convention:** we don't roll back the database. Code rollbacks are fine; schema rollbacks are not. If a release shipped a destructive migration (drop column, drop table), the rollback path is a new forward-only migration that restores the data — never `prisma migrate reset` in prod.

**Steps:**

1. Identify the last known-good release SHA. The release SHA is in `SENTRY_RELEASE` for that deploy.
2. Re-deploy the last-good SHA via your deploy pipeline. Do **not** edit any code — re-deploy the existing artifact.
3. Verify in Sentry: error rate on the new release drops to the pre-incident baseline within 5 minutes.
4. File a postmortem ticket (see [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md)).

**If the bad release ran a migration:**

- If the migration was additive (new column / table / index), keep it. Code rollback is enough.
- If the migration was destructive, file a SEV2 immediately and write a forward-only restoration migration in a hotfix branch.

---

## Restoring from backup

**When:** point-in-time data loss (operator error, bad migration, ransomware).

Backups live in the managed Postgres provider's snapshot service. We don't run our own `pg_dump` schedule because PITR is a managed-service feature and DIY adds a custody surface.

**Steps:**

1. Identify the target restore time. Granularity is determined by your provider; aim for the most recent good moment.
2. Provision a **new** Postgres instance from the snapshot. Never restore in-place over the live primary.
3. Connect a one-shot session to the restored instance and verify the affected rows.
4. Migrate the affected data into the live instance via a transactional `INSERT ... SELECT` or domain-command-driven re-execution.
5. After verification, schedule the restored instance for teardown (don't leave it running — it's a PHI custody risk).

**RLS reminder:** the restored DB has the same RLS / FORCE RLS policies. Use the `pharmax_system` role for cross-tenant inspection during forensic work.

---

## Rotating a KMS data key

**Current state (Phase 4):** `LocalKmsAdapter` only — production refuses to boot. Once `AwsKmsAdapter` lands, this section becomes the canonical rotation procedure.

**Why rotate:** suspected compromise, scheduled annual rotation, or a tenant offboarding (we shred their key).

**Steps (forward-looking, AwsKmsAdapter):**

1. AWS KMS supports automatic annual rotation of customer-managed keys. Enable it once per key.
2. For a **manual** rotation (incident response): create a new key, alias the old one to `*-deprecated`, and update the tenant's pointer in the configuration table.
3. New envelopes will use the new KEK; old envelopes still decrypt against the old key (KMS keeps the key material alive even when the alias is removed).
4. For a **tenant shred** (org leaves the platform): schedule deletion of the KEK in AWS KMS (minimum 7-day delay), then mark all that tenant's encrypted columns as unrecoverable in our metadata table. See [`packages/crypto/src/shred.ts`](../packages/crypto/src/shred.ts).

---

## Rotating a carrier credential

**When:** an API key is suspected to be compromised, or a customer rotates their EasyPost / FedEx / UPS account.

The Phase 4 `carrier_credential` table holds per-tenant credentials with a partial unique index on `(organizationId, provider) WHERE status = 'ACTIVE'`. There's at most one ACTIVE credential per (org, provider) at any time, and DISABLED rows are retained for audit.

**Steps:**

1. Open a session in the affected tenancy context (`SET LOCAL pharmax.organization_id = '...'`).
2. Execute `RegisterCarrierCredential` with the new API key. The command:
   - Transitions the existing ACTIVE row to DISABLED inside the same transaction.
   - Inserts the new ACTIVE row with the new API key (envelope-encrypted with AAD).
   - Writes `command_log` + `audit_log` + `event_outbox`.
3. Verify the next outbound label purchase succeeds (check `event_outbox` for `LabelPurchased` event).
4. Notify the carrier that the old key is no longer in use.

**Never** UPDATE the existing row in place — that breaks the audit history and the AAD binding (the AAD includes the row id; rebinding silently is forbidden).

---

## Replaying a failed Stripe webhook

**When:** Stripe sent an event, but the worker drain failed to process it, and the failure is now resolved.

The `stripe_webhook_event` table has columns `status`, `attempts`, `lastError`. The drain skips rows in terminal status (`PROCESSED`, `FAILED_PERMANENT`).

**Steps:**

1. Find the row:

   ```sql
   SET LOCAL pharmax.system_context = 'on';
   SELECT id, "stripeEventId", "eventType", status, attempts, "lastError"
   FROM stripe_webhook_event
   WHERE "stripeEventId" = 'evt_...';
   ```

2. Reset to a re-drainable status:

   ```sql
   UPDATE stripe_webhook_event
   SET status = 'PENDING', "leasedUntil" = NULL, attempts = 0, "lastError" = NULL
   WHERE id = '...';
   ```

3. The worker drain will pick it up within `STRIPE_DRAIN_INTERVAL_MS`. Watch the logs for the `stripe.webhook.processed` line.

4. If the same row fails again, the dispatcher / handler has a real bug. File a ticket and fix forward.

**Never** craft a fake Stripe event and POST it to `/api/webhooks/stripe` — the signature check will reject it, which is the correct behavior. The replay path is via the DB row.

---

## Resending a failed print job

**When:** a vial label print failed (printer offline, ZPL transport error), the failure resolved, and the operator needs the label printed.

The `print_job` table has lifecycle `PENDING → SENT → COMPLETED | FAILED`. The print-agent claims `SENT` rows for its workstation, sends ZPL, and confirms via `ConfirmVialLabelPrint`.

**Steps:**

1. Do **not** reset the existing row's status. Print jobs are append-only by intent: a re-print is a _new_ job tied to the same order line.
2. Trigger a `ReprintVialLabel` command. The command requires a `reasonCode` (per the workflow safety rules — no silent reprints).
3. The reprint creates a fresh `print_job` row, which the print-agent picks up on its next poll.

If the print-agent itself is offline (workstation power-cycled, network outage):

- The `SENT` rows remain claimable. When the agent reconnects, it picks up where it left off.
- The agent's poll loop has an error-backoff (`errorBackoffMs`) so a transient outage doesn't tight-loop.

---

## Audit chain integrity check

**When:** routine periodic check, after a suspected unauthorized DB write, or as part of a SOC 2 evidence pull.

```sql
-- For one org:
SET LOCAL pharmax.organization_id = '<org-uuid>';
SET LOCAL pharmax.system_context = 'off';

-- Or for everyone (use sparingly — long-running on large tenants):
SET LOCAL pharmax.system_context = 'on';
```

Then run [`verifyAuditChain`](../packages/audit/src/chain/verifier.ts) from a script:

```ts
import { verifyAuditChain } from "@pharmax/audit";
const result = await verifyAuditChain({ organizationId });
if (!result.valid) {
  // result.firstBreakSeq, result.expectedHash, result.actualHash
  // ... page on-call. SEV1.
}
```

**There is currently no scheduled chain check.** A scheduled `audit_chain_check` cron is on the implementation plan; until it lands, run this manually monthly per tenant.

---

## Outbox drain stuck or backed up

**Symptoms:** `event_outbox.status = 'PENDING'` rows grow unbounded. Side effects (email, label print, downstream sync) lag.

**Steps:**

1. Check the worker logs for the most recent `event-outbox-drain` tick. If absent, the worker process is dead — restart it.
2. If the worker is alive but ticks are erroring, look for the failing handler in logs (`outbox.handler.failed`).
3. Backlog can also build during a Stripe / EasyPost outage: a row will stay PENDING through retries up to `OUTBOX_DRAIN_MAX_ATTEMPTS` before flipping to `FAILED_PERMANENT`. That's expected, not an incident.
4. If a particular handler is broken and you need to drain _around_ it, run:

   ```sql
   UPDATE event_outbox
   SET status = 'SKIPPED', "lastError" = 'manually skipped: <ticket>'
   WHERE id IN (...);
   ```

   Then process the skipped rows manually after the fix.

---

## SLA breach storm — emergency bucket walkthrough

**When:** a wave of orders exceeds their SLA and lands in the emergency bucket.

1. Confirm the storm via the orders dashboard (`/admin/orders?bucket=emergency`).
2. Look for a root cause:
   - Is one team's pharmacist out? → reassign by `TeamId`.
   - Is one product family slow? → check `product_id` distribution in the emergency bucket.
   - Is the SLA threshold itself wrong? → update the policy via `WorkflowPolicy` versioning. **Never** mutate the orders' `current_status` directly.
3. Cancel-and-replace for an order requires `CancelOrder` (with disposition) + `CreateOrder`. Both go through the command bus.
4. File a follow-up to ratchet alert thresholds if this wasn't caught early enough.

---

## Migrations: rules of the road

1. **Forward-only.** No `prisma migrate dev` against the prod DB. Use `prisma migrate deploy`.
2. **Every new tenant table needs RLS + FORCE RLS + a `tenant_isolation` policy.** The `pnpm check:migrations` linter enforces this on every PR.
3. **Index every FK and every `(organizationId, ...)` filter combination you actually query.** RLS + missing index = full sequential scan per row.
4. **Destructive changes (DROP, RENAME, type changes) require a two-step:**
   - Step 1: deploy the new column/table alongside the old. Backfill. Dual-write from code.
   - Step 2: a future PR drops the old. Never single-step a destructive change against live traffic.
5. **A migration that fails halfway through is a SEV1.** Postgres is transactional but some DDL (e.g. `CREATE INDEX CONCURRENTLY`) isn't. If a migration aborts:
   - Do **not** run `prisma migrate resolve` to mark it applied. Investigate the partial state first.
   - Open an incident, then either complete the migration manually inside `psql` or write a new forward-only migration that resolves the half-state.
