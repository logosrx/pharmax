# Runbook

Operational procedures for common incidents and routine maintenance. Each section is a self-contained recipe — copy/paste it and adapt.

> **Before you touch production:** confirm you have approval per [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md). Workflow-state mutations outside the command bus are never the right answer — even in an incident, the command bus is the path.

## Table of contents

1. [Rolling back a deploy](#rolling-back-a-deploy)
2. [Restoring from backup](#restoring-from-backup)
3. [Rotating a KMS data key](#rotating-a-kms-data-key)
4. [Rotating the KMS search-key (HMAC) key](#rotating-the-kms-search-key-hmac-key)
5. [KMS boot validation failures](#kms-boot-validation-failures)
6. [Verifying KMS in production](#verifying-kms-in-production)
7. [Quarterly KMS rotation drill](#quarterly-kms-rotation-drill)
8. [Rotating a carrier credential](#rotating-a-carrier-credential)
9. [Replaying a failed Stripe webhook](#replaying-a-failed-stripe-webhook)
10. [Resending a failed print job](#resending-a-failed-print-job)
11. [Audit chain integrity check](#audit-chain-integrity-check)
12. [Outbox drain stuck or backed up](#outbox-drain-stuck-or-backed-up)
13. [SLA breach storm — emergency bucket walkthrough](#sla-breach-storm--emergency-bucket-walkthrough)
14. [Migrations: rules of the road](#migrations-rules-of-the-road)
15. [Re-running a missed Merkle manifest](#re-running-a-missed-merkle-manifest)
16. [Verifying a Merkle manifest from S3](#verifying-a-merkle-manifest-from-s3)
17. [Verifying every chain + manifest in a run](#verifying-every-chain--manifest-in-a-run)
18. [Rotating the Merkle signing key](#rotating-the-merkle-signing-key)
19. [Object Lock retention extension](#object-lock-retention-extension)

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

**Scope:** the AWS KMS `ENCRYPT_DECRYPT` CMK referenced by
`AWS_KMS_DATA_KEY_ID` and used by `AwsKmsAdapter` (ADR-0023) to
wrap per-encrypt DEKs. This is the key that protects every PHI
field at rest.

**Why rotate:** suspected compromise (SEV1 — go to incident
response first), satisfying a SOC 2 evidence event, or replacing a
key whose key policy needs structural change beyond what
`aws kms put-key-policy` can express.

> **Routine annual rotation is automatic.** AWS KMS rotates the
> underlying key material every ~365 days on customer-managed
> keys with rotation enabled (`enable_key_rotation = true` in
> `infra/terraform/modules/kms`). Automatic rotation is
> transparent to callers — both `GenerateDataKey` and `Decrypt`
> keep working without code or config change. Use the manual
> procedure below only when you need to swap the **CMK
> identity**, not just its underlying material.

### Manual CMK rotation (forward-only)

The `kid` format `aws:kek:<keyIdLabel>:<tenantId>:v1` reserves a
version slot for explicit application-level epoch bumps. The
`keyIdLabel` segment is the operator-visible identifier that
`AWS_KMS_KEY_LABEL` controls; rotating the CMK while keeping the
same label is the supported path. Rotating BOTH the CMK and the
label is also supported but doubles the work below — do them as
separate deploys.

1. **Provision the new CMK in Terraform.** Add an
   `aws_kms_key.app_phi_v2` (sibling to the existing key) plus an
   alias `alias/pharmax/app-phi-key-v2`. Keep both keys' aliases
   live. `terraform plan` → review → `terraform apply` in the
   target environment.
2. **Grant the ECS task role access to both keys.** The IAM
   policy must list both ARNs under
   `kms:GenerateDataKey`/`kms:Decrypt`/`kms:DescribeKey`. The old
   key needs `Decrypt` (so historical envelopes still unwrap);
   the new key needs the full set.
3. **Deploy the web + worker tasks with `AWS_KMS_DATA_KEY_ID`
   pointing at the NEW alias.** The boot-time `validate()` call
   exercises `DescribeKey` against the new key — if IAM is
   wrong, boot fails loudly per the
   [boot-validation runbook](#kms-boot-validation-failures).
4. **Verify with `pnpm verify:kms`.** See
   [Verifying KMS in production](#verifying-kms-in-production).
   The script wraps + unwraps a synthetic DEK end-to-end against
   the new key.
5. **Confirm new envelopes carry the new kid.** Spot-check the
   next PHI write via a tenant-scoped query:

   ```sql
   SET LOCAL pharmax.organization_id = '<spot-check-org>';
   SELECT id, "encryptionMeta"->>'kid' AS kid
   FROM patient
   ORDER BY "createdAt" DESC LIMIT 5;
   ```

   New rows MUST emit `aws:kek:<label>:<tenantId>:v1` referencing
   the new label/CMK pair (or the same label if you kept it
   stable, in which case the kid is unchanged but CloudTrail
   shows traffic moving to the new key ARN).

6. **Decommission the old CMK** after a reasonable bake-in
   window (we wait at least one quarter to ensure no in-flight
   request still references the old key):
   - Remove the alias.
   - Schedule deletion in AWS KMS with a 30-day window.
   - Drop the old key's IAM permissions from the task role.
   - Remove the Terraform resource for `app_phi_v1`.

### Application-level kid version bump

If you need to bump the kid version slot (`v1 → v2`) — e.g.
because you migrated to a new wrap scheme — coordinate with the
`@pharmax/crypto` package owners. Today the slot is reserved and
the adapter only emits `v1`; changing it requires updating
`AwsKmsAdapter.kidFor()` and the parser. This is a code-level
change, not an operator-time runbook step.

### Tenant offboarding (crypto-shred)

For a tenant leaving the platform, the rotation procedure is NOT
the right path. See
[`packages/crypto/src/shred.ts`](../packages/crypto/src/shred.ts)
— offboarding overwrites the per-tenant envelope rows with a
shred marker. With AWS KMS automatic rotation enabled we do NOT
delete the KEK material itself (deleting a CMK whose key material
is shared across tenants would break the other tenants).

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

---

## Backup automation + tested restore

**Goal:** "we have backups" is only credible when paired with "we have tested a restore last quarter." This section ties the automated backup configuration to the standing operational procedure that proves it works.

### What's automated

Backups are managed-service backups on RDS, configured in IaC:

- **Source of truth:** [`infra/terraform/modules/rds/main.tf`](../infra/terraform/modules/rds/main.tf) — `aws_db_instance.this` with `backup_retention_period`, `backup_window`, `copy_tags_to_snapshot`, and `enabled_cloudwatch_logs_exports`.
- **Retention:** `backup_retention_period = 35` (the RDS maximum, ≥ 6× the HIPAA minimum). Configurable via `var.rds_backup_retention_days`; the variable validation enforces ≥ 7 and our prod tfvars hard-code 35.
- **Encryption:** snapshots inherit the customer-managed `rds` KMS key — the same key the live primary uses. The CloudTrail `Decrypt` history on that key is the auditor's primary-key evidence trail.
- **Window:** `03:00-04:00 UTC`. The maintenance window (`Sun:04:30-Sun:05:30 UTC`) is adjacent and intentionally avoids overlap.
- **Snapshot tagging:** `copy_tags_to_snapshot = true` so every snapshot inherits `DataClassification = phi` and the project / environment tags — required for the backup-scan policy in the security review.
- **Deletion protection:** `deletion_protection = true` on prod and staging; can only be disabled in a focused PR with a reviewer.

There is no DIY `pg_dump`. Adding one would create a new PHI custody surface (the dump file would live somewhere) for no incremental durability benefit.

### Why drills are mandatory

The [restore-from-backup recipe above](#restoring-from-backup) is the _incident_ path. It assumes you remember it under pressure. The drill is how we keep that memory current.

**Cadence:** quarterly. Skipping a quarter is a SOC 2 finding.

**Procedure:** [`docs/operations/restore-drill.md`](operations/restore-drill.md) — point-in-time restore into a throwaway RDS instance in the isolated subnet group, verify the audit chain with `verifyAuditChain`, capture evidence per the template, then tear the instance down within 24 hours.

**Owner:** the drill captain is rotated each quarter. The captain assigns one observer (any other engineer with prod RDS read).

**Evidence:** the drill captures a structured evidence pack (provisioning command, engine-version match, audit-chain output, row-count snapshot, RLS sanity, RDS configuration screenshot, teardown confirmation). The pack lives in the quarterly drill folder in document storage and is what the SOC 2 auditor reads.

**Failure mode:** if the verifier reports a chain break or RLS lets through cross-tenant rows, the drill becomes an incident. **Do not destroy the restored instance** — it is evidence. Follow [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md).

### Drift between IaC and reality

Any operator-side change to backup retention, the backup window, or snapshot deletion behavior MUST be made in `infra/terraform/modules/rds/` and applied via the standard plan/apply flow — never via the AWS console. The nightly Terraform drift-detection job (see [`infra/terraform/README.md`](../infra/terraform/README.md#drift-detection)) catches console drift and pages on-call.

---

## Disaster recovery: regional failover

**When:** AWS `us-east-1` is unrecoverable for the SLA window
(typically `> 60 minutes`), or a regional service degradation (KMS,
RDS, ECS) makes the primary region unsafe to keep running. This is a
SEV0 unless explicitly downgraded by the CEO.

**Goal:** move the production traffic plane to `us-west-2` (the warm
standby region provisioned by
[`infra/terraform/environments/prod/us-west-2/`](../infra/terraform/environments/prod/us-west-2/))
without touching the failed primary. Per ADR 0022, no PHI crosses a
regional boundary; the failover model treats `us-west-2` as a
**fresh starting point** for new data while the source region is
offline.

> **Read first:**
> [`docs/adr/0022-multi-region-tenancy.md`](adr/0022-multi-region-tenancy.md)
> §3 (KMS regionality) and §6 (Webhook ingress). The KMS regionality
> point is the one that catches teams off-guard during their first
> failover drill.

### Pre-conditions

- The DR stack `environments/prod/us-west-2/` has been applied at
  least once and is healthy (`make plan-prod-usw2` reports no diff).
- The DR Secrets Manager entries (`pharmax-prod-usw2/*`) are populated
  with current secret values. The rotation runbook covers this; the
  invariant is "every prod secret rotation also writes to us-west-2."
- The us-west-2 ALB has a Route53 `dr.pharmax.example.com` ALIAS
  record pointing at it, **separate** from `app.pharmax.example.com`.
- The most recent cross-region RDS snapshot copy is fresh enough for
  the data-loss tolerance the operator is willing to accept.

If any of these is FALSE, **stop and update the runbook before
continuing** — the failover is no longer rehearsal-grade.

### Step 1 — declare the incident

Open a SEV0 incident channel. Page on-call + the CEO. Confirm in
writing (Slack thread is fine) that the failover decision is made.

### Step 2 — capture state

Snapshot what we know about the primary's state at the cutover moment:

```bash
# Most recent RDS snapshot id in us-east-1.
aws rds describe-db-snapshots \
  --db-instance-identifier pharmax-prod-use1-postgres \
  --region us-east-1 \
  --query 'reverse(sort_by(DBSnapshots, &SnapshotCreateTime))[0].DBSnapshotIdentifier' \
  --output text

# Audit chain head per organization (last successful verifier run).
# Reference docs/operations/restore-drill.md §2.2 for the verifier command.
```

These values go into the postmortem; they also feed step 3.

### Step 3 — restore data into us-west-2

The DR region's RDS instance is empty by default — capacity-only.
Restore the most recent cross-region snapshot copy:

```bash
# 1. Copy the latest us-east-1 snapshot to us-west-2 (encrypted with
#    the us-west-2 RDS CMK). This is a new ciphertext under a new
#    key — that's the cross-region invariant; PHI ciphertext does
#    NOT travel between regions verbatim.
aws rds copy-db-snapshot \
  --source-db-snapshot-identifier "arn:aws:rds:us-east-1:<account>:snapshot:<latest>" \
  --target-db-snapshot-identifier "pharmax-prod-usw2-failover-$(date +%Y%m%d%H%M)" \
  --kms-key-id "arn:aws:kms:us-west-2:<account>:key/<usw2-rds-cmk>" \
  --source-region us-east-1 \
  --region us-west-2

# 2. Wait until COPYING -> AVAILABLE.
aws rds wait db-snapshot-available \
  --db-snapshot-identifier pharmax-prod-usw2-failover-... \
  --region us-west-2

# 3. Restore into a NEW instance (do not modify the one Terraform manages —
#    your next `terraform apply` would conflict).
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier pharmax-prod-usw2-postgres-failover \
  --db-snapshot-identifier pharmax-prod-usw2-failover-... \
  --multi-az \
  --no-publicly-accessible \
  --db-subnet-group-name pharmax-prod-usw2-db \
  --vpc-security-group-ids "$USW2_RDS_SG" \
  --deletion-protection \
  --region us-west-2
```

### Step 4 — reconfigure secrets in us-west-2

Update the DR `database-url` to point at the restored endpoint:

```bash
RESTORED_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier pharmax-prod-usw2-postgres-failover \
  --region us-west-2 \
  --query 'DBInstances[0].Endpoint.Address' --output text)

aws secretsmanager put-secret-value \
  --secret-id pharmax-prod-usw2/database-url \
  --secret-string "postgres://pharmax_admin:<password>@$RESTORED_ENDPOINT:5432/pharmax?sslmode=require" \
  --region us-west-2
```

### Step 5 — scale the DR ECS services

Either edit `environments/prod/us-west-2/terraform.tfvars` to bump
`ecs_*_desired_count` and `terraform apply`, OR scale directly via
the AWS CLI for speed (and reconcile to IaC after the incident):

```bash
aws ecs update-service --cluster pharmax-prod-usw2-cluster \
  --service pharmax-prod-usw2-web --desired-count 5 --region us-west-2
aws ecs update-service --cluster pharmax-prod-usw2-cluster \
  --service pharmax-prod-usw2-worker --desired-count 3 --region us-west-2
```

The ECS deployment circuit breaker will roll back on a failed task
start; watch `aws ecs describe-services` until `runningCount =
desiredCount`.

### Step 6 — flip Route53

Swap `app.pharmax.example.com` from the us-east-1 ALB to the
us-west-2 ALB. TTL was lowered to 60s in advance during the
quarterly DR drill rehearsal:

```bash
USW2_ALB_DNS=$(cd infra/terraform/environments/prod/us-west-2 && terraform output -raw alb_dns_name)
USW2_ALB_ZONE=$(cd infra/terraform/environments/prod/us-west-2 && terraform output -raw alb_zone_id)

cat > /tmp/failover.json <<JSON
{
  "Comment": "DR failover us-east-1 -> us-west-2",
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "app.pharmax.example.com.",
      "Type": "A",
      "AliasTarget": {
        "HostedZoneId": "$USW2_ALB_ZONE",
        "DNSName": "$USW2_ALB_DNS",
        "EvaluateTargetHealth": true
      }
    }
  }]
}
JSON

aws route53 change-resource-record-sets \
  --hosted-zone-id "$ROUTE53_ZONE" \
  --change-batch file:///tmp/failover.json
```

### Step 7 — vendor webhooks

Stripe, EasyPost, FedEx, UPS, and Clerk all need their webhook
endpoint changed. Each vendor dashboard has the relevant control:

- **Stripe:** Developers → Webhooks → endpoint URL → save.
- **Clerk:** Webhooks → endpoint URL → save. Rotate the signing
  secret if compromise is suspected; the rotation procedure is in
  `docs/security/secrets-management.md` §5.
- **EasyPost / FedEx / UPS:** vendor-specific. Each has a runbook
  entry above.

This step is **manual and ordered**. A vendor that times out a
webhook delivery during the swap will be retried; the worker
inbound-event tables hold the duplicate-detection key so retries
don't double-apply.

### Step 8 — what stays blocked

While `us-east-1` KMS is offline:

- **Reading existing us-east-1 PHI** is impossible from any region.
  Per-tenant KEKs live in us-east-1 KMS. We accept this — the
  failover serves new data only until the source region returns.
- **Daily Merkle manifests for us-east-1-pinned tenants** cannot be
  produced. The next day's run after recovery includes a separate
  manifest for the gap window; the missed day is documented in the
  evidence pack as a forced gap, not a chain break.
- **Search blind indexes** computed in us-east-1 are unreadable from
  us-west-2 (different search CMK). Search in the DR region
  recomputes from us-west-2 plaintext as new records are written.

ADR 0022 §3 explicitly covers this trade.

### Step 9 — postmortem

Capture the timeline, the customer-facing impact, the duration of
each step, and any divergence from this runbook. The postmortem
becomes evidence for the SOC 2 audit (CC7.4) and for the BCP/DR
quarterly review.

### Recovery — returning to us-east-1

After `us-east-1` returns:

1. Reverse the Route53 ALIAS swap during a low-traffic window.
2. Reconcile data: the canonical source is now us-west-2; new
   us-east-1 records (if any survived the outage) are merged via
   a per-tenant operator-mediated reconciliation (no automated
   merge — the audit-chain semantics demand a deliberate
   re-write).
3. Reverse the vendor webhook URLs.
4. Scale us-west-2 back to warm-standby capacity.

The full reconciliation procedure is its own runbook — too long for
this section. File a follow-up ticket for the reconciliation captain.

---

## Terraform: deploy-related operations

This section is the operator-facing surface for routine Terraform
work. The full IaC documentation is in
[`infra/terraform/README.md`](../infra/terraform/README.md); this
runbook entry is the "what do I run when X happens" reference.

### Routine plan / apply

```bash
cd infra/terraform
make plan-staging-use1   # plan only, dry-run
make plan-prod-use1      # plan only, dry-run

# After review:
cd environments/prod/us-east-1
terraform apply tfplan
```

Production applies are gated behind a CI workflow with required
approvals — see `.github/workflows/`. The Makefile target stops at
`plan` deliberately; a `make apply-prod` would be a SOC 2 CC8.1
finding waiting to happen.

### Drift detection — nightly cron

A nightly job runs:

```bash
cd infra/terraform
make drift-prod-use1
make drift-prod-usw2
```

Each target runs `terraform plan -detailed-exitcode -lock=false`.
Exit code `2` = drift; the job pages on-call. Reconcile by editing
this directory, never via the AWS console. Console-drift on KMS,
IAM, S3, or RDS resources is itself a SOC 2 CC8.1 finding (someone
made an unmanaged change).

### Bootstrapping a new env-region

Per `infra/terraform/README.md` § "First-time bootstrap":

1. Run `infra/terraform/bootstrap/` once for the new (account, env,
   region) tuple. Captures: state bucket name, lock table name, KMS
   ARN.
2. Plug those into the env-region's `backend.tf` (copy from
   `backend.tf.example`).
3. Edit `terraform.tfvars` (region, vpc_cidr, ACM cert domain).
4. `terraform init && terraform plan && terraform apply`.

The Makefile init targets (`make init-prod-use1` etc.) are the
operator-shortcut for step 4.

### Rotating the Merkle-signing key

The asymmetric signing CMK is **NOT auto-rotated** by AWS KMS.
Rotation is operator-driven:

1. In Terraform, add a new `aws_kms_key.asymm_sign_v2` to the kms
   module (don't replace the existing one). Plan + apply.
2. Update the `MerkleRootSigner` config in the worker to start
   signing new manifests under the v2 alias. Keep the v1 alias
   active so verifiers can still validate historical manifests.
3. After all relevant historical manifests have been verified at
   least once under v1 (typically the next quarterly drill), update
   the iam module to drop `kms:Sign` from the v1 key. v1 still
   supports `kms:Verify` and `kms:GetPublicKey` so old manifests
   stay verifiable.
4. After 1+ year, alias v1 to `*-deprecated` and stop publishing
   the verification key. The signed manifests are still verifiable
   because each manifest carries `signerKid`; the verifier accepts
   any historically-trusted kid.

This is the canonical key-rotation event for the audit-archive
posture. Treat it like a SOC 2 evidence event — capture the
before/after CloudTrail line item showing the new key in use.

---

## Rotating `CLERK_WEBHOOK_SECRET`

**When:** scheduled rotation (annually), suspected leak, or any time the operator who provisioned the original secret leaves the team.

The Svix webhook signature is the only thing that authenticates inbound `/api/webhooks/clerk` traffic. A leaked signing secret lets an attacker forge `user.deleted` events and lock real operators out, so rotation is treated as a SEV2 if the leak is suspected.

**Steps:**

1. **Rotate in the Clerk dashboard.** _Webhooks → Endpoints → your prod endpoint → "Rotate signing secret"_. Clerk shows the new secret ONCE and does not display it again. Copy it immediately to a secrets manager paste buffer.
2. **Rotate in AWS Secrets Manager.** Update the `pharmax/<env>/clerk/webhook-secret` secret value to the new string. The ECS task definition references the secret by ARN, so a new task picks it up on the next deployment.
3. **Restart the web tier.** Force a new deployment (`vercel deploy --force` for the Next.js Vercel deploy, or `aws ecs update-service --force-new-deployment` for ECS). The bootstrap-time hard-fail in `apps/web/src/server/bootstrap.ts` will block boot if the secret is missing — that's the safety net.
4. **Verify the next delivery.** Trigger a Clerk webhook from the dashboard ("Send test event"). Confirm in CloudWatch Logs that the receiver ack'd 200 with status `applied` or `noop_*`. A 400 `invalid_signature` means the deployed task is still using the old secret — repeat step 3.

**During the rotation window:** Clerk does NOT serve both secrets simultaneously. There is a small window between dashboard rotation and ECS rollout where signature verification will fail; Svix retries with backoff so the missed deliveries replay automatically once the new task is live. The `clerk_webhook_event` ledger's `svixMessageId` unique constraint guarantees those replays are safe.

---

## Off-boarding an operator

**When:** an operator leaves the team or has their access revoked.

The Pharmax `user` row is NEVER deleted (HIPAA + SOC 2 require us to retain identity history for audit-log references). Off-boarding flips the row's `status` to `TERMINATED` and clears `clerkUserId`.

**Procedure:**

1. **Delete the Clerk identity.** Clerk dashboard → Users → find by email → "Delete". This invalidates all live sessions for that user.
2. **Webhook flow runs automatically.** Clerk fires `user.deleted` to `/api/webhooks/clerk`. The dispatcher (`apps/web/src/server/auth/clerk-webhook-handlers.ts`) flips the linked Pharmax row to `TERMINATED`, clears `clerkUserId`, and writes a chain-linked audit_log entry with `action="auth.clerk.user_terminated"`.
3. **Verify in audit_log.** Run inside the operator's organization tenancy:

   ```sql
   SET LOCAL pharmax.organization_id = '<org-uuid>';
   SELECT id, action, "resourceId", metadata, "occurredAt", seq
   FROM audit_log
   WHERE action = 'auth.clerk.user_terminated'
     AND "resourceId" = '<pharmax-user-uuid>'
   ORDER BY seq DESC
   LIMIT 1;
   ```

   The `metadata.clerkUserId` field should match the Clerk identity that was deleted; `previousStatus` records the row's status before termination.

4. **Verify session expiry.** Any stale browser session for that operator now resolves to `RESOLVE_TENANCY_USER_NOT_ACTIVE` at `resolveOperatorTenancyContext` (the row is no longer `ACTIVE`). The operator console renders the "Account inactive" message and `auth.protect()` redirects to `/sign-in`.

**If the webhook delivery is lost:** the dispatcher is idempotent on `svix-id`. Re-fire the delivery from the Clerk dashboard (see "Re-running a missed Clerk webhook delivery" below).

**Manual fallback (no webhook flow):** if the webhook is broken or you need to off-board faster than Clerk's webhook latency, run the same effect manually:

```sql
SET LOCAL pharmax.system_context = 'on';
UPDATE "user"
SET status = 'TERMINATED', "clerkUserId" = NULL
WHERE "clerkUserId" = '<clerk-user-id>';
```

This bypasses the audit chain. **File a follow-up** to write a manual `audit_log` entry covering the action — operator off-boarding without an audit trail is a SOC 2 gap.

---

## Re-running a missed Clerk webhook delivery

**When:** Clerk reports an undelivered or failed webhook, OR an off-boarding event didn't propagate to Pharmax.

The `clerk_webhook_event` table holds every signature-verified delivery keyed by `svix-id`. The receiver is idempotent on this id, so re-firing the same delivery is always safe.

**Steps:**

1. **Find the original delivery in the Clerk dashboard.** Webhooks → Endpoints → your prod endpoint → "Message Attempts". Locate the failed delivery by event id or timestamp.
2. **Click "Resend".** Clerk re-fires the delivery with the SAME `svix-id`. The receiver:
   - Looks up the existing `clerk_webhook_event` row.
   - If `status` is `APPLIED` or `NOOP`, returns 200 with `status: "replay"` and does NOT re-run the dispatcher.
   - If `status` is `PENDING` (a previous attempt crashed mid-tx), re-runs the dispatcher. Handlers' guarded updates make this safe.
   - If `status` is `FAILED`, re-runs the dispatcher and updates the row to the new outcome.
3. **Confirm in the ledger.**
   ```sql
   SET LOCAL pharmax.system_context = 'on';
   SELECT id, "svixMessageId", "eventType", status, "dispatchOutcome",
          attempts, "lastError", "receivedAt", "dispatchedAt"
   FROM clerk_webhook_event
   WHERE "svixMessageId" = 'msg_...';
   ```

**Never** craft a fake Clerk event and POST it to `/api/webhooks/clerk` — the Svix signature check rejects it (the correct behavior). The replay path is via the Clerk dashboard. The `clerk_webhook_event` ledger guarantees safety even if a replay races a fresh delivery.

---

## MFA enrollment for OrgAdmin / BillingManager

**When:** a new operator is invited to an `OrgAdmin` or `BillingManager` role, or an existing operator hits a 403 with `code=MFA_REQUIRED` on a privileged write.

Pharmax enforces a platform-side MFA floor for these two role codes (see ADR-0025 §3 and `apps/web/src/server/auth/require-mfa.ts`). The floor is independent of any Clerk org-level policy; the operator MUST have at least one second factor enrolled before they can finalize an invoice, issue a refund, register a carrier credential, or assign roles.

**Operator-facing flow:**

1. Operator clicks a privileged button (e.g. "Finalize invoice") in the operator console.
2. The route handler resolves their Clerk session and asks Clerk Backend API how many factors they have enrolled. Zero factors → the route redirects with `?error=MFA_REQUIRED:...`.
3. The operator opens the user button (top right of the console) → **Manage account** → **Security** → **Add a method**. Clerk supports TOTP (recommended), backup codes, and SMS.
4. After enrolling at least one factor, the operator retries the original action. The MFA gate's `React.cache` is request-scoped, so the retry triggers a fresh Clerk Backend API call and the new factor is visible.

**Admin-facing diagnostics:**

If an operator reports they cannot enroll, check:

- **Clerk dashboard** → Users → find by email → "Multi-factor". The dashboard shows enrolled factors; if none are listed, the operator hasn't completed the enrollment ceremony.
- **Application log feed** for `auth.mfa.required_not_enrolled` or `auth.mfa.lookup_failed` events. The latter indicates Clerk Backend API connectivity issues; rotate to the "Clerk outage" runbook section if it persists.
- **Audit log** for `action="auth.clerk.session_created"` rows — the metadata records `userStatus`, so a `userStatus != ACTIVE` would explain a denial that's NOT MFA-related.

**Adding a new role to the floor:** edit `MFA_REQUIRED_ROLE_CODES` in `apps/web/src/server/auth/require-mfa.ts` AND the corresponding test (`require-mfa.test.ts`'s "locks in OrgAdmin and BillingManager" assertion will fail until updated). Note the change in `SECURITY.md` per ADR-0025's ongoing obligation.

---

## Rotating the KMS search-key (HMAC) key

**Scope:** the AWS KMS `GENERATE_VERIFY_MAC` / `HMAC_256` CMK
referenced by `AWS_KMS_SEARCH_KEY_ID` and used by
`AwsKmsAdapter.deriveSearchKey()` to derive the per-tenant,
per-purpose HMAC key that produces every blind index in the
database.

> **READ THIS FIRST.** Rotating this key invalidates **every
> blind index in the system** — the entire `*_bid` family of
> columns (`patient.firstNameBid`, `patient.dobBid`,
> `provider.npiBid`, etc.) becomes unsearchable for rows that
> were indexed under the old key. Patient search will silently
> return empty results for historical rows until the backfill
> completes. This is a multi-hour-to-multi-day operation
> depending on tenant size — **never** do it casually.

### When to rotate

- **HMAC key compromise** (the only mandatory cause). The HMAC
  key allows offline computation of blind indexes, so a leak is
  a SEV1 — it does NOT decrypt PHI, but it does let an attacker
  enumerate "does the index for `firstname=alice@org-1` exist?"
  for any tenant + value they care to try.
- **NOT** for routine scheduled rotation. The HMAC CMK has the
  same FIPS HSM custody as the data CMK; routine rotation
  doesn't materially improve the posture and the operational
  cost (backfill) is significant.

### Procedure

1. **Pre-flight: confirm the backfill capacity.** Estimate
   `SUM(rowcount)` across every PHI table with a `*_bid` column.
   The backfill is a full re-scan of those rows. Plan a window
   that fits inside one polling interval of your patient-search
   SLA (or accept a temporary search blackout for older rows).
2. **Provision the new HMAC CMK in Terraform.** Add an
   `aws_kms_key.search_key_v2` (sibling, `KeySpec=HMAC_256`,
   `KeyUsage=GENERATE_VERIFY_MAC`) plus an alias
   `alias/pharmax/search-key-v2`. Apply.
3. **Grant the ECS task role access to both keys.** The IAM
   policy needs `kms:GenerateMac` + `kms:DescribeKey` on both
   ARNs during the migration window.
4. **Deploy with `AWS_KMS_SEARCH_KEY_ID` pointing at the new
   alias.** Boot-time `validate()` runs `DescribeKey` against
   both keys. The boot now serves search keys derived from the
   new CMK; **new** PHI writes get blind indexes under the new
   key, **old** rows still have old-key blind indexes.
5. **Run the blind-index backfill.** This is a per-table loop
   that re-computes the `*_bid` columns from the decrypted PHI
   fields using the new search key. The backfill code lives in
   [`packages/crypto`](../packages/crypto) — work with the
   crypto package owners to dispatch the backfill jobs through
   the worker (do NOT run a raw SQL `UPDATE` — the AAD binding
   requires the field cipher).
6. **Verify search.** For each rotated tenant, run a few known
   search probes (synthetic data only — never use real PHI in
   the verification log). All probes must return the expected
   rows.
7. **Decommission the old HMAC CMK.** Same waterfall as for the
   data CMK: remove alias, schedule deletion, drop IAM, remove
   Terraform resource. Wait at least one full backfill duration
   plus a margin (typically a week) before scheduling deletion.

If the backfill aborts midway, the database is in a mixed state
(some rows indexed under v1, some under v2). The crypto package
exposes a per-row marker; the resume path picks up where the
previous run stopped. **Do not flip the env var back to the old
key during a partial backfill** — that would create a third
state where some rows are searchable under no current key.

---

## KMS boot validation failures

**Symptom:** `apps/web` or `apps/worker` exits at startup with one
of these messages:

- `Refusing to boot apps/web in production: AWS_REGION, AWS_KMS_DATA_KEY_ID, and AWS_KMS_SEARCH_KEY_ID must all be set.`
- `KMS_KEY_NOT_FOUND` / `CRYPTO_VALIDATION` thrown from
  `AwsKmsAdapter.validate()`.

The container immediately health-checks unhealthy; ECS will keep
spinning up replacement tasks until the underlying problem is
fixed. **Stop scaling and triage** — autoscaling will not heal
this.

### Triage tree

1. **Missing env vars.** Confirm the ECS task definition resolves
   all three values (`AWS_REGION`, `AWS_KMS_DATA_KEY_ID`,
   `AWS_KMS_SEARCH_KEY_ID`) from Secrets Manager. The
   `valueFrom` ARNs must match what Terraform produced; a stale
   ARN (e.g. after re-creating the secret) is the most common
   "missing env" cause.

2. **IAM AccessDenied on `kms:DescribeKey`.** CloudWatch Logs
   will show the underlying SDK error. Check:
   - Does the ECS task role include `kms:DescribeKey` for BOTH
     key ARNs? Both keys are required.
   - Is the key policy on the CMK itself allowing the task
     role's account+role principal? KMS authorization is
     `key policy AND IAM`; either side denying is enough.
   - Is the IAM principal correct? An ECS task can be running
     with the **task execution role** instead of the **task
     role** when the task role isn't attached; the execution
     role typically doesn't include KMS data-plane permissions.

3. **Key is `Enabled=false`.** Someone disabled the CMK via the
   AWS console (or it auto-disabled during a pending-deletion
   window). Re-enable via console or `aws kms enable-key`. If
   the key is in pending deletion, cancel deletion before the
   window expires — once a CMK is deleted, all PHI wrapped
   under it is **unrecoverable**.

4. **Wrong KeyUsage / KeySpec.** `validate()` enforces:
   - Data key: `KeyUsage=ENCRYPT_DECRYPT`,
     `KeySpec=SYMMETRIC_DEFAULT`.
   - Search key: `KeyUsage=GENERATE_VERIFY_MAC`,
     `KeySpec=HMAC_256`.

   If you accidentally pointed `AWS_KMS_DATA_KEY_ID` at the
   HMAC CMK (or vice versa) the error message names both the
   expected and actual values. Fix the env var and redeploy.

5. **Regional KMS outage.** Cross-check the
   [AWS Service Health Dashboard](https://health.aws.amazon.com/)
   for the region in `AWS_REGION`. KMS regional outages are
   rare but real (the most recent us-east-1 event in 2023 took
   KMS down for ~2 hours). If KMS is genuinely down:
   - Do NOT roll back the deploy — the rollback target will
     also fail to boot.
   - Do NOT change `AWS_REGION` to a healthy region — the CMK
     is regional and a different-region CMK does not have the
     key material.
   - Stand down on new deploys; existing tasks (if any are
     still running) continue serving against their cached
     connections. Update the status page and wait.
   - See [Disaster recovery: regional failover](#disaster-recovery-regional-failover)
     if the outage extends past the 60-minute SLA window.

6. **Cross-tenant kid in unwrap path.** A `KMS_KEY_NOT_FOUND`
   thrown from `unwrapDataKey` (not from `validate`) with a kid
   like `kek:org-x:v1` (no `aws:` prefix) means a LocalKmsAdapter
   envelope landed in front of the AWS adapter. This is a
   serious data-integrity event — a non-prod row leaked into
   prod, or a misconfigured non-prod task wrote into the prod
   database. File a SEV1 immediately; do NOT attempt to "decrypt
   anyway" by switching the adapter.

After fixing the root cause, redeploy. Boot success is observable
via the `apps/web bootstrap complete` / `worker.boot` structured
log line and a clean `pnpm verify:kms` run from a one-off task.

---

## Verifying KMS in production

**When:** after every deploy that touches `@pharmax/crypto`, the
KMS Terraform module, the ECS task role, or the
`AWS_KMS_*` secrets. Also as part of the quarterly KMS evidence
collection for SOC 2.

The check is intentionally lightweight: it does NOT touch the
database, does NOT exercise any application code that reads PHI,
and uses a synthetic tenant id (`verify-script-tenant`) that
cannot collide with a real organization.

### Run from a one-off ECS task

The script is bundled with the worker image (`tsx
scripts/security/verify-kms-keys.ts`). Dispatch it as a
`RunTask` invocation against the production cluster:

```bash
aws ecs run-task \
  --cluster pharmax-prod-use1-cluster \
  --task-definition pharmax-prod-use1-verify-kms \
  --launch-type FARGATE \
  --region us-east-1 \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIVATE_SUBNETS],securityGroups=[$KMS_VERIFY_SG],assignPublicIp=DISABLED}"
```

The task runs `pnpm verify:kms` (which resolves to `tsx
scripts/security/verify-kms-keys.ts`) and exits 0 on success.
CloudWatch Logs captures one JSON line per step:

```jsonl
{"ok":true,"step":"env.resolved","details":{...}}
{"ok":true,"step":"validate"}
{"ok":true,"step":"generateDataKey","details":{...}}
{"ok":true,"step":"unwrapDataKey"}
{"ok":true,"step":"deriveSearchKey"}
{"ok":true,"step":"crossTenantRejection.kidMismatch"}
{"ok":true,"step":"complete"}
```

A non-zero exit + a `{"ok":false,...}` line indicates the failing
step. The boot-validation triage tree above applies to the
`validate` step; for other steps, the error message names the
underlying AWS error class (`AccessDeniedException`,
`InvalidCiphertextException`, `DisabledException`, etc.).

### Run locally against prod KMS (engineer triage)

Engineers with `AwsAssumeRole` rights to the prod KMS reader role
can run the script from their workstation:

```bash
aws sts assume-role \
  --role-arn arn:aws:iam::<prod-account>:role/PharmaxProdKmsVerify \
  --role-session-name "verify-kms-$(whoami)" \
  --duration-seconds 900 \
  > /tmp/creds.json

export AWS_ACCESS_KEY_ID=$(jq -r .Credentials.AccessKeyId /tmp/creds.json)
export AWS_SECRET_ACCESS_KEY=$(jq -r .Credentials.SecretAccessKey /tmp/creds.json)
export AWS_SESSION_TOKEN=$(jq -r .Credentials.SessionToken /tmp/creds.json)
export AWS_REGION=us-east-1
export AWS_KMS_DATA_KEY_ID=alias/pharmax/app-phi-key
export AWS_KMS_SEARCH_KEY_ID=alias/pharmax/search-key
export AWS_KMS_KEY_LABEL=app-phi

pnpm verify:kms
```

The role MUST be the **read-only verify role**, not a full crypto
role — it grants `Describe/GenerateDataKey/Decrypt/GenerateMac`
but NOT `ScheduleKeyDeletion`, `DisableKey`, or
`PutKeyPolicy`. The role's CloudTrail entries are flagged in the
audit feed as engineer-initiated checks (`session_name` carries
the operator id).

**Never** point `pnpm verify:kms` at the prod KMS from a process
that also has access to the prod database. The script never
touches the DB, but combining the two role surfaces in a single
session widens the blast radius unnecessarily.

---

## Quarterly KMS rotation drill

**Why this exists.** A rotation procedure that has never been
executed is not a procedure — it's a hypothesis. The rotation
runbooks above (data key, search key, Merkle signing key) read
like they will work, but until they are actually run end-to-end
in a controlled environment, none of them are evidence-grade.
The quarterly drill turns hypothesis into rehearsed muscle
memory and produces a dated artifact for SOC 2 CC6.7.

**Cadence:** quarterly. Skipping a quarter is a SOC 2 finding.
The drill captain is rotated each quarter (same rotation as the
[restore drill](#restoring-from-backup) for operational symmetry).

**Scope:** the drill exercises one of the three CMK rotation
procedures per quarter, on a rotating schedule:

| Quarter      | Key under test                                          |
| ------------ | ------------------------------------------------------- |
| Q1 (Jan–Mar) | Data key (`aws_kms_key.data`, ADR-0023)                 |
| Q2 (Apr–Jun) | Search key (`aws_kms_key.search`)                       |
| Q3 (Jul–Sep) | Merkle signing key (`aws_kms_key.asymm_sign`, ADR-0024) |
| Q4 (Oct–Dec) | Data key again (the most security-critical)             |

Drills run in **staging** — never in production. The staging
environment has its own copy of every CMK in the inventory
(`infra/terraform/environments/staging/us-east-1/`); the drill
provisions a sibling key alongside, performs the alias swap,
runs the verification suite, then rolls back.

### Pre-flight (one week before the drill)

1. **Designate the captain + observer.** The observer is any
   other engineer with staging KMS write access. Both names go
   into the evidence pack header.
2. **Read the per-key runbook entry one more time.** The drill
   is the rehearsal; the procedure is unchanged.
3. **Confirm staging is healthy.**
   - `pnpm verify:kms` against staging passes.
   - The web + worker apps in staging are running with the
     current alias mapping.
   - No active incident is in flight in staging (the drill
     should be observable in CloudTrail without noise).
4. **Open a ticket.** Title:
   `KMS rotation drill <YYYY>-Q<N>: <key under test>`. The
   ticket is the evidence container.

### Drill steps (data-key example — Q1, Q4)

The flow below targets the data key. For the search key (Q2),
substitute the HMAC alias and add the blind-index backfill from
the
[search-key rotation runbook](#rotating-the-kms-search-key-hmac-key)
§5. For the Merkle signing key (Q3), substitute the asymmetric
alias and the
[Merkle signer rotation runbook](#rotating-the-merkle-signing-key).

1. **Snapshot the starting state.** Capture, into the ticket:
   - The current alias → CMK mapping (`aws kms list-aliases`).
   - The current `AWS_KMS_DATA_KEY_ID` value in the staging
     task definition (alias name).
   - A `pnpm verify:kms` run against staging (the "before"
     artifact).
2. **Provision the drill CMK.** In Terraform, add an
   `aws_kms_key.data_drill_q<N>` sibling resource with the
   same key spec + policy as the production data key. Plan +
   apply. Capture the plan output.
3. **Add the drill alias.** `alias/pharmax-staging-use1-data-drill-q<N>`
   pointing at the drill CMK. Capture the alias creation
   CloudTrail line.
4. **Update IAM.** The staging ECS task role's IAM policy must
   list the drill CMK ARN under
   `kms:GenerateDataKey`/`kms:Decrypt`/`kms:DescribeKey`
   IN ADDITION TO the current production alias. Do NOT remove
   the production alias — the drill is non-destructive.
5. **Deploy the staging tasks with `AWS_KMS_DATA_KEY_ID`
   pointing at the drill alias.** Watch the deploy logs:
   - Boot must succeed with the new alias.
   - `apps/web bootstrap complete` and `worker.boot` lines
     should appear.
   - The first PHI write after the deploy should produce a
     `kid` containing the drill key label (spot-check via the
     query in step 4 of the
     [data-key rotation runbook](#rotating-a-kms-data-key)).
6. **Run `pnpm verify:kms` against the drill alias.** Capture
   the JSON output (the "during" artifact). All steps must
   pass.
7. **Roll back.** Re-deploy the staging tasks with
   `AWS_KMS_DATA_KEY_ID` pointing back at the original alias.
   Boot must succeed.
8. **Decommission the drill CMK.** In Terraform, remove the
   drill alias, schedule the drill CMK for deletion (30-day
   window), and remove its IAM grant. Plan + apply. Capture
   the destroy plan.
9. **Capture the closing snapshot.** A final `pnpm verify:kms`
   against staging (the "after" artifact). The state must be
   identical to the starting state.

### Search-key drill notes (Q2)

The search-key drill has an extra step: between steps 6 and 7,
**run a small blind-index backfill against synthetic data only**.
Do NOT backfill real staging data — the staging environment may
contain mirror copies of production tenants whose blind indexes
must remain stable. Provision a single throwaway organization,
write 5–10 PHI rows under the drill alias, confirm the search
returns them, then delete the organization before rollback. The
goal of the drill is to exercise the
`computeSearchKey` → `Mac` → `Buffer` round-trip end-to-end
against an actual rotated key, not to test backfill at scale.

### Merkle signer drill notes (Q3)

The asymmetric signing key has a longer-lived public key PEM that
auditors keep indefinitely. The drill exports the drill key's PEM
(`aws kms get-public-key`) and verifies a synthetic Merkle root
end-to-end through `pnpm security:sign-merkle --prod` (pointed at
staging) followed by `pnpm security:verify-merkle`. The drill PEM
goes into the ticket and is **not** added to the long-lived
evidence repo (the drill key is destroyed at the end; preserving
its PEM would clutter the trust store).

### Evidence pack contents

The ticket attaches:

- Captain + observer names.
- "Before" `verify:kms` output.
- Terraform plan + apply for the drill CMK + alias + IAM.
- Deploy logs showing the new alias in use.
- "During" `verify:kms` output.
- A representative encrypted write's `kid` from the staging DB
  (synthetic-data-only).
- Terraform plan + destroy for the drill resources.
- "After" `verify:kms` output.
- Captain's narrative: any divergence from the runbook, any
  surprise, any change needed to the runbook.

### When the drill fails

A drill failure is **a finding**, not an incident. The fix is to
update the runbook to reflect what actually happens, then
re-run the drill with the corrected procedure. Track via the
follow-up ticket; close it before the next quarter's drill.

A drill that fails **and** leaves staging in a degraded state
escalates to an incident. The most common cause is forgetting
step 7 (the rollback) — staging continues to point at the drill
alias. Page on-call to redeploy with the original alias.

### Drill output goes into the SOC 2 evidence pack

The ticket's attachments are the artifact for SOC 2 CC6.7 ("the
entity uses cryptography to support encryption ... per its
security policies"). The auditor wants to see one drill per
quarter, dated, with the captain attested. Skipping a quarter
means CC6.7 evidence is missing for that period.

---

## Re-running a missed Merkle manifest

**When:** the nightly worker loop skipped an organization (logged
as `merkle.run.org_failed` in the `merkle.run.complete` digest) and
the missed day needs a manifest in the audit archive.

The nightly loop's per-org isolation by design — one bad signer
call cannot stop the whole run, but a skipped org leaves a gap in
the daily-manifest series. The gap is evident in the next
nightly digest (`brokenChains` + `merkleFailures` lines) and in the
auditor's evidence pack.

**Steps:**

1. **Identify the org + date.** The worker emits
   `merkle.run.org_failed` with `{ organizationId, slug, code,
errorMessage }`. Pull the org id and the UTC date the run
   targeted from the structured log line.

2. **Fix the root cause first.**
   - `MERKLE_SIGN_FAILED` with `AccessDeniedException` →
     `kms:Sign` on the signing CMK is missing from the worker IAM.
     Fix in Terraform, deploy, then re-run.
   - `MERKLE_PUBLISH_FAILED` with `ServiceUnavailable` → transient
     S3 outage. Confirm S3 is healthy in the
     [AWS Service Health Dashboard](https://health.aws.amazon.com/),
     then re-run.
   - `MERKLE_MANIFEST_OVERWRITE_REFUSED` → the manifest is ALREADY
     in the bucket under Object Lock. This is the idempotent
     happy path; the loop already counts it as a success. No
     action needed.

3. **Re-run the script for the missed day.**

   ```bash
   pnpm security:sign-merkle \
     --org-id=<organization-uuid> \
     --date=YYYY-MM-DD \
     --prod
   ```

   - `--prod` switches the script to `KmsAsymmetricSigner` +
     `S3ObjectLockPublisher`. The script reads
     `MERKLE_SIGNER_KMS_KEY_ID`, `AUDIT_ARCHIVE_S3_BUCKET`,
     `AUDIT_ARCHIVE_S3_KMS_KEY_ID`, `AWS_REGION` from env.
   - The S3 publisher is **idempotent**: a second run for the
     same org + date observes the existing manifest via
     `HeadObject` and returns its metadata WITHOUT a second PUT.
     This is enforced by Object Lock COMPLIANCE + the
     `IfNoneMatch: *` conditional.
   - Omit `--org-id` to re-run every organization for the same
     missed day; the idempotency above keeps re-runs safe even on
     orgs that already shipped a manifest.

4. **Confirm the manifest is in the bucket.**

   ```bash
   aws s3api head-object \
     --bucket "$AUDIT_ARCHIVE_S3_BUCKET" \
     --key "<organizationId>/YYYY/MM/DD/merkle-manifest.json"
   ```

   The response includes `ObjectLockMode: COMPLIANCE` and
   `ObjectLockRetainUntilDate` set to "now + retention period." If
   the head returns 404, the publish silently failed (e.g. wrong
   bucket name) — re-check env vars and re-run.

5. **Verify the manifest end-to-end.** Run the verifier (see
   [Verifying a Merkle manifest from S3](#verifying-a-merkle-manifest-from-s3))
   to confirm the manifest is internally consistent AND matches
   the live audit log.

**Never** edit a manifest object that already exists. Object Lock
COMPLIANCE refuses overwrite — that property is exactly what makes
the manifest evidence. A "corrected" manifest goes under a new key
suffix (e.g. `merkle-manifest-rerun.json`) only with explicit
auditor approval, and the original stays in place forever.

---

## Verifying a Merkle manifest from S3

**When:** an auditor asks "did this period get tampered with?", a
compliance review pulls an evidence sample, or an incident
response includes "are we sure these audit rows are the same ones
that were there a month ago?"

The verifier re-derives the Merkle root from the live `audit_log`
rows in the manifest's `[periodStart, periodEnd)` window and
checks the signature against a pinned public key. It never touches
KMS — the verification is offline so the auditor never needs AWS
credentials.

**Steps:**

1. **Obtain the public key PEM.** For the production ECDSA
   signer, the operator runs once and saves the result:

   ```bash
   aws kms get-public-key \
     --key-id "$MERKLE_SIGNER_KMS_KEY_ID" \
     --query 'PublicKey' --output text | base64 -d > /tmp/merkle-signing.spki.der
   openssl pkey -inform DER -pubin -in /tmp/merkle-signing.spki.der \
     -out evidence/merkle-signing-pubkey.pem
   ```

   The PEM is **not secret** — the SOC 2 evidence pack should
   include it under each period's folder. Auditors verify
   manifests against this PEM without any AWS access.

2. **Verify against the live audit log.**

   ```bash
   pnpm security:verify-merkle \
     --manifest=s3://$AUDIT_ARCHIVE_S3_BUCKET/<org>/YYYY/MM/DD/merkle-manifest.json \
     --public-key=evidence/merkle-signing-pubkey.pem
   ```

   The script:
   - Pulls the manifest via `S3ObjectLockPublisher.fetch()` (when
     given an `s3://` URI) or reads a local file copy.
   - Re-derives the Merkle root from the live `audit_log` in
     `[periodStart, periodEnd)`.
   - Verifies the signature using `EcdsaP256SignatureVerifier`
     (or `LocalEd25519SignatureVerifier` for dev-mode manifests).
   - Exits 0 + prints a structured `{ valid: true, leafCount,
... }` JSON on success; exits 1 + prints
     `{ valid: false, reason, detail, ... }` to stderr on
     failure.

3. **Interpret failure reasons.**
   - `merkle-root-mismatch` → live audit rows do NOT produce the
     signed root. **Tamper signal.** Open a SEV1 incident; do NOT
     write a "corrected" manifest.
   - `signature-invalid` → manifest body is unchanged but the
     signature does not verify under the supplied PEM. Possible
     PEM mismatch (wrong key version) OR a forged manifest. Confirm
     the PEM matches `manifest.signerKid`.
   - `domain-tag-mismatch` → the manifest's `signingDomainTag` is
     not `pharmax/audit-merkle/v1`. Either a schema bump landed in
     the verifier path without corresponding updates here, or the
     manifest was hand-crafted. SEV1.
   - `signer-kid-untrusted` → `--trusted-signer-kids` was supplied
     and the manifest's kid is not in the allowlist. Either expected
     (e.g. rotated key) or a forged manifest.

4. **Capture the output for the evidence pack.**

   ```bash
   pnpm security:verify-merkle \
     --manifest=s3://... \
     --public-key=evidence/merkle-signing-pubkey.pem \
     > evidence/<period>/PI1.4/verify-<org>-YYYY-MM-DD.json
   ```

   The JSON includes the manifest's `rootHashHex`, `signerKid`,
   `algorithm`, leaf count, and the verifier verdict. That file is
   the SOC 2 PI1.4 artifact for the period.

---

## Verifying every chain + manifest in a run

**When:** monthly cadence per organization (SOC 2 CC7.2 evidence)
or before a deploy that touches `@pharmax/audit` /
`@pharmax/security`.

The combined verifier walks every organization, replays the audit
chain with `verifyChain`, AND pulls each org's most recent Merkle
manifest from S3 and re-verifies it against the live audit log.

```bash
pnpm security:verify-chain-all \
  --public-key=evidence/merkle-signing-pubkey.pem \
  --manifest-date=YYYY-MM-DD
```

The script prints a TSV table with one row per org:

```
chain   merkle  verifiedRows  lastSeq  slug    organizationId  merkleUri  reason
OK      OK      1234          1234     org-a   <uuid>          s3://...   (none)
OK      BROKEN  1234          1234     org-b   <uuid>          s3://...   merkle-root-mismatch: ...
```

- Any `chain=BROKEN` row is a SEV1.
- Any `merkle=BROKEN` row on a chain that's `OK` indicates the
  chain has been rewritten AFTER the manifest was signed. SEV1.

Use `--skip-merkle` only when the Merkle pipeline is not yet wired
in the target environment (e.g. an isolated staging tier).

---

## Rotating the Merkle signing key

**Scope:** the AWS KMS asymmetric CMK referenced by
`MERKLE_SIGNER_KMS_KEY_ID`. KeySpec MUST be `ECC_NIST_P256`,
KeyUsage MUST be `SIGN_VERIFY`. AWS KMS does NOT auto-rotate
asymmetric keys — rotation is operator-driven.

> **READ THIS FIRST.** The verifier accepts any historically-
> trusted `signerKid` because each manifest carries its kid. Old
> manifests stay verifiable across rotation; only the IDENTITY
> the auditor's trust store accepts changes. Plan to keep the old
> public key PEM around — auditors will use it to verify
> historical periods for years.

**Steps:**

1. **Provision the new CMK in Terraform.** Add an
   `aws_kms_key.audit_signer_v2` (sibling to the existing key),
   `KeySpec=ECC_NIST_P256`, `KeyUsage=SIGN_VERIFY`. Plan + apply.

2. **Grant the worker IAM role access to the new key.** The IAM
   policy needs `kms:Sign` + `kms:GetPublicKey` on the new ARN.
   Keep `kms:GetPublicKey` (NOT `kms:Sign`) on the old ARN so the
   verifier can still fetch the historical public key if needed.

3. **Export the new public key PEM.** Same `aws kms get-public-key`
   procedure as in "Verifying a Merkle manifest from S3," step 1.
   Commit the new PEM next to the old one in the evidence repo —
   each period's pack pins the PEM that was current when the
   period's manifests were signed.

4. **Deploy with `MERKLE_SIGNER_KMS_KEY_ID` set to the new ARN.**
   On boot, the loop's `KmsAsymmetricSigner.getPublicKeyPem()`
   call validates `KeySpec` + `KeyUsage` against the new key. If
   they don't match (operator picked the wrong KMS key), boot
   fails with `MERKLE_PUBLIC_KEY_FETCH_FAILED` — that's the safety
   net.

5. **Confirm new manifests carry the new kid.** The next morning's
   manifests will have `signerKid` =
   `aws:kms:asymm:<new-key-arn>:v1`. Spot-check from the audit
   archive:

   ```bash
   aws s3api get-object \
     --bucket "$AUDIT_ARCHIVE_S3_BUCKET" \
     --key "<orgId>/<YYYY>/<MM>/<DD>/merkle-manifest.json" \
     /tmp/manifest.json
   jq .signerKid /tmp/manifest.json
   ```

6. **Decommission the old CMK.** After a reasonable bake-in (we
   wait one quarter — long enough for the next quarterly audit
   review):
   - Remove `kms:Sign` from any IAM policy that still has it on
     the old key.
   - Keep the old CMK around (do NOT schedule for deletion). The
     verifier may need its public key to validate historical
     manifests indefinitely.
   - If you do schedule deletion, **export the public key PEM to
     the evidence repo first** and use AWS KMS' minimum 7-day
     pending-deletion window to catch operator error.

The signed manifests are still verifiable across the rotation
because each manifest carries `signerKid`. The
`MultiKidSignatureVerifier` accepts any kid in its dispatcher; the
auditor's verification fixture maps kid → PEM, so as long as the
old PEM is preserved, old manifests verify forever.

---

## Object Lock retention extension

**When:** legal or compliance requires extending retention beyond
the manifest's current `ObjectLockRetainUntilDate` — for example,
a litigation hold or a regulator inquiry that needs the evidence
preserved past the standard 7-year horizon.

**Critical property:** COMPLIANCE-mode Object Lock retention can
only be **extended**, never shortened. No IAM principal (including
the root account) can delete or overwrite a locked object before
the retain-until date. That's the load-bearing property; do NOT
move to GOVERNANCE-mode (which permits bypass).

**Steps:**

1. **Identify the affected objects.** The Merkle manifest key
   layout is `<orgId>/<YYYY>/<MM>/<DD>/merkle-manifest.json`. For
   a litigation hold scoped to one tenant, list under that
   tenant's prefix:

   ```bash
   aws s3 ls "s3://$AUDIT_ARCHIVE_S3_BUCKET/<orgId>/" --recursive
   ```

2. **Compute the new retain-until date.** Example: extending the
   current retention by 5 more years from today.

   ```bash
   NEW_RETAIN_UNTIL=$(date -u -d "+5 years" +"%Y-%m-%dT%H:%M:%SZ")
   ```

3. **Apply the extension per-object.**

   ```bash
   aws s3api put-object-retention \
     --bucket "$AUDIT_ARCHIVE_S3_BUCKET" \
     --key "<orgId>/YYYY/MM/DD/merkle-manifest.json" \
     --retention "Mode=COMPLIANCE,RetainUntilDate=$NEW_RETAIN_UNTIL"
   ```

   For bulk extension, script the list + per-object call. There is
   no batch operation that extends retention across a prefix; each
   object is its own retention configuration.

4. **For the litigation-hold case, ALSO apply a legal hold.** A
   legal hold blocks delete/overwrite independent of retention
   expiry, so it stays in place even after the retention window
   normally expires. Legal holds can be lifted by a holder of
   `s3:PutObjectLegalHold` — coordinate with legal + compliance.

   ```bash
   aws s3api put-object-legal-hold \
     --bucket "$AUDIT_ARCHIVE_S3_BUCKET" \
     --key "<orgId>/YYYY/MM/DD/merkle-manifest.json" \
     --legal-hold "Status=ON"
   ```

5. **Record the extension in the evidence pack.** Capture the
   `aws s3api get-object-retention` output for each affected
   object — the SOC 2 / HIPAA evidence pack must show the
   retention was extended deliberately, not by an automated job.

6. **Update IaC.** If the extension is permanent (e.g. policy
   change extending retention for all new manifests), update
   `AUDIT_ARCHIVE_RETENTION_YEARS` in the worker env AND any
   Terraform default. The change applies to **future** manifests
   only — existing manifests keep the retention they were written
   with unless explicitly extended per the procedure above.

**Never** attempt to bypass retention via:

- Switching the bucket to GOVERNANCE-mode and using
  `s3:BypassGovernanceRetention`. That defeats the threat model
  in ADR-0024.
- Disabling Object Lock on the bucket. Object Lock cannot be
  disabled once enabled on a bucket.
- Re-creating the bucket. The bucket is referenced by the worker's
  env vars and by the audit-archive Terraform module; recreating
  it would lose evidence and is itself a SOC 2 finding.

Any of the above is a **SEV1** compliance incident.
