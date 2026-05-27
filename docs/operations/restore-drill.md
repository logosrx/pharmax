# Quarterly RDS restore drill

**Cadence:** once per calendar quarter. Skipping is a SOC 2 finding.

**Why we drill:** "we have backups" without "we have tested a restore"
is a folk tale. The restore path exercises (a) IAM permissions on the
restorer, (b) RDS snapshot ↔ KMS key bindings, (c) the application's
behavior against a fresh database, and (d) the audit-chain verifier
against historical data — all things that quietly rot.

**Scope:** restore the most recent production RDS snapshot into a
**new, throwaway** RDS instance in a non-prod environment, prove the
audit chain still verifies, capture evidence, then tear the restored
instance down. The live primary is never touched.

> **Never restore in-place over the production primary.** Always
> restore into a fresh instance. See [`docs/RUNBOOK.md`](../RUNBOOK.md#restoring-from-backup)
> for the production-incident path; this document is the dry-run that
> proves we _can_ execute that path under pressure.

---

## 0. Pre-flight

- [ ] Open the quarterly drill ticket (template at the bottom of this
      file). Assign the drill captain and one observer.
- [ ] Snapshot the in-flight scheduled date. The drill MUST land within
      the same calendar quarter even if rescheduled.
- [ ] Confirm the prod KMS `rds` CMK is healthy — restores fail silently
      with a misconfigured CMK alias.
- [ ] Confirm the prod RDS instance is currently producing automated
      backups (`describe-db-instance --query 'DBInstances[0].BackupRetentionPeriod'`
      returns ≥ 35).
- [ ] Note the prod RDS instance id and the most recent restorable
      time (`describe-db-instances --query 'DBInstances[0].LatestRestorableTime'`).

---

## 1. Provision the restored instance

The restored instance lives in the **same VPC + isolated subnet group**
as the source (so it cannot accidentally route to the public internet
or be reached by a stray operator workstation). It uses a distinct
identifier suffixed with `-drill-<YYYYMMDD>`.

```bash
# Variables (fill these for the drill day):
SRC_DB_ID="pharmax-prod-postgres"
RESTORE_TIME="2026-01-15T12:00:00Z"             # within retention window
NEW_DB_ID="pharmax-prod-postgres-drill-$(date +%Y%m%d)"

aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$SRC_DB_ID" \
  --target-db-instance-identifier "$NEW_DB_ID" \
  --restore-time "$RESTORE_TIME" \
  --no-multi-az \
  --no-publicly-accessible \
  --db-subnet-group-name pharmax-prod-db \
  --vpc-security-group-ids sg-XXXXXXXXXXXXXXXXX \
  --db-instance-class db.t4g.large \
  --copy-tags-to-snapshot \
  --enable-cloudwatch-logs-exports postgresql upgrade \
  --deletion-protection
```

Notes:

- `--no-multi-az` keeps the drill cheap. The point is restore _correctness_,
  not HA testing.
- `--no-publicly-accessible` is non-negotiable. PHI must remain in the
  isolated tier.
- `--vpc-security-group-ids` references a **drill-only** SG that allows
  inbound 5432 from one developer workstation via a jumpbox / SSM
  session manager. Do NOT reuse the production app SG.
- `--deletion-protection` is on so a copy/paste destroy doesn't wipe the
  drill before evidence is captured.

Wait for `Status = available` (typically 15-40 min depending on
instance size).

```bash
aws rds wait db-instance-available --db-instance-identifier "$NEW_DB_ID"
```

---

## 2. Verify

### 2.1 Smoke connection

```bash
PGPASSWORD="$(aws secretsmanager get-secret-value --secret-id pharmax-prod/database-password --query SecretString --output text)" \
  psql -h <restored-endpoint> -U pharmax_admin -d pharmax -c "SELECT now(), version();"
```

The version string MUST match the production engine version. If it
doesn't, that's a finding — major-version upgrades during restore are
not supposed to happen without an explicit flag.

### 2.2 Audit-chain integrity

The drill's headline check: run the audit verifier against the restored
data. The verifier walks the hash-chained `audit_log` per organization
and reports the first break (if any).

```bash
# From a workstation with the restored DB's connection string in DATABASE_URL:
DATABASE_URL="postgres://pharmax_admin:...@<restored-endpoint>:5432/pharmax?sslmode=require" \
  pnpm --filter @pharmax/audit verify:all
```

Where `verify:all` is the wrapper script around
[`verifyAuditChain`](../../packages/audit/src/chain/verifier.ts) that
iterates over every organization, captures the result, and exits
non-zero on the first break.

Spot-check the `audit_chain_state` table directly:

```sql
SET LOCAL pharmax.system_context = 'on';

SELECT organization_id, last_seq, last_hash, last_committed_at
FROM audit_chain_state
ORDER BY last_committed_at DESC
LIMIT 20;
```

Compare the `last_hash` values for two or three orgs against the same
query against the live primary. They must match for snapshots taken at
the same point in time (modulo any audit-log writes that landed in the
intervening seconds — note them and re-query if needed).

### 2.3 Critical-table row counts

Sanity-check that the restore wasn't truncated:

```sql
SET LOCAL pharmax.system_context = 'on';

SELECT
  (SELECT count(*) FROM "organization")            AS orgs,
  (SELECT count(*) FROM "user")                    AS users,
  (SELECT count(*) FROM "order")                   AS orders,
  (SELECT count(*) FROM "audit_log")               AS audit_rows,
  (SELECT count(*) FROM "event_outbox")            AS outbox_rows;
```

Numbers should be within +/- (RPO-window) of the live primary.

### 2.4 RLS sanity

RLS policies travel with the schema; the restored DB must still refuse
cross-tenant reads.

```sql
-- Without setting organization_id, every tenant table should return zero rows
-- (because RLS in FORCE mode applies even to the table owner without an org context).
RESET ALL;
SELECT count(*) FROM "patient";   -- expect 0
```

If you get rows back, RLS is wrong — that's a SEV1 finding and the
drill must escalate to an incident.

---

## 3. Capture evidence

The SOC 2 auditor will ask for proof the drill ran. Capture this set
into the quarterly drill folder in document storage:

1. The full output of `aws rds restore-db-instance-to-point-in-time`
   (including the chosen `RESTORE_TIME`).
2. `aws rds describe-db-instances --db-instance-identifier "$NEW_DB_ID"`
   JSON output (proves Multi-AZ off, encrypted on, isolated subnets).
3. The `psql` version string from §2.1.
4. The `verify:all` exit code, full stdout, and a SHA-256 of the
   output file.
5. The row-count snapshot from §2.3 with the matching production
   counts for comparison.
6. A screenshot of the RDS console "Configuration" tab on the restored
   instance, showing storage encryption with the correct CMK alias.
7. The drill captain's sign-off note (1-2 paragraphs: what was tested,
   what passed, what was flagged).

Use the template at the bottom of this file. Do NOT capture any PHI
in screenshots — crop / blur if a query result accidentally exposes a
patient column.

---

## 4. Teardown

Drill instances must be destroyed within 24 hours. They are a PHI
custody risk every minute they live.

```bash
# 1. Disable deletion protection.
aws rds modify-db-instance \
  --db-instance-identifier "$NEW_DB_ID" \
  --no-deletion-protection \
  --apply-immediately

# 2. Destroy (no final snapshot — the drill's purpose was to verify the
#    snapshot we already have, not to create a new one).
aws rds delete-db-instance \
  --db-instance-identifier "$NEW_DB_ID" \
  --skip-final-snapshot \
  --delete-automated-backups
```

Capture the destroy confirmation into the evidence folder.

Verify it's gone:

```bash
aws rds wait db-instance-deleted --db-instance-identifier "$NEW_DB_ID"
aws rds describe-db-instances --db-instance-identifier "$NEW_DB_ID"
# Should return DBInstanceNotFoundFault
```

Close the quarterly drill ticket with a link to the evidence folder.

---

## Evidence-capture template

Copy this block into the quarterly drill ticket and fill it in.

```text
QUARTERLY RDS RESTORE DRILL — Q?-YYYY
=====================================

Captain:        <name>
Observer:       <name>
Started:        <ISO timestamp>
Completed:      <ISO timestamp>
Drill instance: pharmax-prod-postgres-drill-YYYYMMDD
Source:         pharmax-prod-postgres
Restore time:   <ISO timestamp within retention window>

§1. Provision
- aws-cli command:        attached / inline
- Engine version match:   PASS | FAIL — explain

§2. Verify
- psql smoke connect:     PASS | FAIL
- verify:all exit code:   0 | non-zero
- Audit chain breaks:     none | list
- Row counts vs primary:  attached
- RLS sanity:             PASS | FAIL

§3. Teardown
- Destroy completed:      <ISO timestamp>
- Instance not found:     PASS | FAIL

§4. Findings
- <any anomalies; "none" if clean>

§5. Sign-off
- Drill captain confirms the production restore path is exercised
  end-to-end as of the timestamp above. Evidence attached.
  Signed: <name>
```

---

## Failure mode: the drill fails

If the verifier reports a chain break, RLS lets through cross-tenant
rows, or the restored instance can't boot the app:

1. **Stop.** Do not destroy the restored instance. It is now evidence.
2. File a SEV1 ticket and follow
   [`docs/INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md).
3. Notify the SOC 2 auditor within the contractual window if the
   finding affects the integrity claim.
4. The drill becomes the artifact of the incident — preserve all the
   evidence above plus full Postgres logs and an `EXPLAIN ANALYZE` of
   the verifier's first failing query.

---

## Restoring from RDS automated backup — incident path

This is the production incident path for "we need this data back from
the most recent restore point" — distinct from the quarterly drill above
(which uses the same primitive in a non-prod context to verify the
machinery still works).

> **Never** restore in-place over the production primary. The recipes
> below always restore into a NEW instance. The live primary stays
> healthy; the restored instance is the surgical-recovery scratch space.

### When to use this

- Operator-error data loss: a bad migration, an erroneous bulk update,
  ransomware (vanishingly unlikely on RDS, but the recipe still applies).
- Forensic inspection: an auditor or incident commander wants to compare
  the live primary against a known-good prior point.
- Compliance evidence: the SOC 2 auditor asks "show me a restore at
  this point in time."

### Pre-conditions

- The RDS automated backup window covers your target restore point
  (35 days for prod by Terraform default — see
  `infra/terraform/modules/rds/main.tf` `backup_retention_period`).
- The RDS CMK (`alias/pharmax-prod-use1-rds`) is healthy. Restores
  fail silently with a misconfigured CMK alias.
- You know the precise restore time (ISO timestamp, UTC).
- You have IAM permission to call `rds:RestoreDBInstanceToPointInTime`
  in the target region. Most engineers do not — break-glass via the
  emergency-access procedure if needed.

### Step 1 — pick the restore point

Find the latest restorable time:

```bash
aws rds describe-db-instances \
  --db-instance-identifier pharmax-prod-use1-postgres \
  --query 'DBInstances[0].LatestRestorableTime' \
  --output text
```

Pick a time **just before** the bad event. For "the migration ran at
2026-04-12T14:32:11Z and corrupted data," the restore time is
`2026-04-12T14:31:00Z` — one minute earlier. PITR granularity is the
1-second window between commits.

### Step 2 — provision the restored instance

```bash
SRC_DB_ID="pharmax-prod-use1-postgres"
RESTORE_TIME="2026-04-12T14:31:00Z"
NEW_DB_ID="pharmax-prod-use1-postgres-restore-$(date +%Y%m%d%H%M)"
SUBNET_GROUP="pharmax-prod-use1-db"
RESTORE_SG="sg-XXXXXXXXXXXXXXXXX"  # break-glass-only SG; not the prod app SG

aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$SRC_DB_ID" \
  --target-db-instance-identifier "$NEW_DB_ID" \
  --restore-time "$RESTORE_TIME" \
  --no-multi-az \
  --no-publicly-accessible \
  --db-subnet-group-name "$SUBNET_GROUP" \
  --vpc-security-group-ids "$RESTORE_SG" \
  --db-instance-class db.r6g.large \
  --copy-tags-to-snapshot \
  --enable-cloudwatch-logs-exports postgresql upgrade \
  --deletion-protection
```

The same `--no-multi-az`, `--no-publicly-accessible`, isolated-subnet
constraints from §1 of the drill apply here. PHI must remain in the
isolated tier even on a restore.

Wait for `Status = available` (15-40 min):

```bash
aws rds wait db-instance-available --db-instance-identifier "$NEW_DB_ID"
```

### Step 3 — verify

Per the drill recipe in §2 above (smoke connect, audit chain integrity,
row counts, RLS sanity). The restored DB has the same schema and the
same RLS / FORCE RLS / `pharmax_app` role configuration. The audit
chain head should match the live primary at the moment of `RESTORE_TIME`.

### Step 4 — surgical migrate the affected data

Now the production-incident-specific work. Inspect the restored data,
identify the rows you need to recover, and migrate them into the live
primary. **Never** swap the live primary for the restored instance — the
live primary has the latest commits since `RESTORE_TIME`; replacing it
loses everything in that window.

The recovery is application-driven through the command bus, NOT raw
SQL:

1. Use the restored DB to drive an inspection script. Read the rows
   that need recovery into a structured manifest.
2. For each row, drive a `RecoverFromBackup` command (or the relevant
   domain-specific command) against the live primary. Each command
   writes `command_log`, `audit_log`, and `event_outbox` per the
   workflow contract — the recovery itself is auditable.
3. **Do NOT** `INSERT ... SELECT` into the live primary directly.
   That bypasses RLS, the audit chain, and the AAD binding on PHI
   envelopes.

For non-PHI metadata (e.g. recovering an accidentally-deleted clinic
record), an operator-mediated SQL recovery inside the system context
is acceptable. Document the SQL in the postmortem.

### Step 5 — teardown

The restored instance is a PHI custody risk every minute it lives:

```bash
aws rds modify-db-instance \
  --db-instance-identifier "$NEW_DB_ID" \
  --no-deletion-protection \
  --apply-immediately

aws rds delete-db-instance \
  --db-instance-identifier "$NEW_DB_ID" \
  --skip-final-snapshot \
  --delete-automated-backups
```

Verify deletion:

```bash
aws rds wait db-instance-deleted --db-instance-identifier "$NEW_DB_ID"
```

### Step 6 — postmortem

Same evidence template as the quarterly drill (§3 evidence-capture
template). Add an "Incident context" section describing what triggered
the restore, the chosen `RESTORE_TIME`, and the `RecoverFromBackup`
commands executed against the live primary.

### Cross-region restore (DR scenario)

If the source region itself is offline, point the
`copy-db-snapshot` + `restore-db-instance-from-db-snapshot` recipes
in `docs/RUNBOOK.md` § "Disaster recovery: regional failover" instead.
The cross-region path is meaningfully different because the snapshot
must be copied across regions before restore, and the restored
instance lives in a different KMS context.

---

## Terraform-related procedures around restore

### Verifying the IaC backup configuration matches reality

The drill's pre-flight (§0) checks that `BackupRetentionPeriod` is
≥ 35. The IaC source of truth is `infra/terraform/modules/rds/main.tf`
`backup_retention_period`, which is parameterized as
`var.rds_backup_retention_days`.

If the AWS console value drifts from the IaC value, the nightly
drift-detection job pages on-call (per
`infra/terraform/README.md#drift-detection`). The reconciliation is
to edit the .tfvars (or accept the console value into the .tfvars)
and `terraform apply`.

### Verifying the snapshot CMK is the IaC-managed key

```bash
aws rds describe-db-snapshots \
  --db-instance-identifier pharmax-prod-use1-postgres \
  --query 'reverse(sort_by(DBSnapshots, &SnapshotCreateTime))[0].KmsKeyId' \
  --output text
```

The returned ARN should match
`infra/terraform/environments/prod/us-east-1` output `kms_rds_key_arn`.
Any other value is a finding.

### Provisioning the cross-region snapshot copy

The cross-region snapshot copy schedule is **not** managed by the RDS
module today — RDS native cross-region snapshot copy is per-snapshot
on-demand, not continuous. The DR runbook (`docs/RUNBOOK.md` § Disaster
recovery: regional failover, Step 3) shows the on-demand copy command.

A planned enhancement is to add an EventBridge schedule + Lambda to
take a daily cross-region snapshot copy automatically. When that lands,
the schedule is owned by `infra/terraform/modules/rds/` (or a new
`modules/dr/` if it grows beyond one resource).
