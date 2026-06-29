# Quarterly Aurora restore drill

**Cadence:** once per calendar quarter. Skipping is a SOC 2 finding.

**Why we drill:** "we have backups" without "we have tested a restore"
is a folk tale. The restore path exercises (a) IAM permissions on the
restorer, (b) Aurora backup ↔ KMS key bindings, (c) the application's
behavior against a fresh database, and (d) the audit-chain verifier
against historical data — all things that quietly rot.

> **Helper script:** the drill is run via
> [`scripts/operations/run-restore-drill.ts`](../../scripts/operations/run-restore-drill.ts)
> (see [§5 below](#5-helper-script)). The script automates the parts
> that benefit from code — deterministic id computation, read-only
> preflight (KMS health + retention + LatestRestorableTime cross-check),
> exact-runnable AWS-CLI emission, audit-chain verification across all
> orgs, and SOC 2-shaped evidence composition. The destructive AWS
> calls (`restore-db-cluster-to-point-in-time`, `delete-db-cluster`)
> are still run by the human drill captain.

> **Aurora restores are cluster-based, not instance-based.** Point-in-time
> recovery restores a new **cluster** (storage volume); you then attach one
> or more **instances** to it before you can connect. Teardown is the
> reverse: delete the instances, then the cluster. The database module is
> Aurora PostgreSQL — see [ADR 0029](../adr/0029-aurora-postgresql-database-platform.md).

**Scope:** restore the production Aurora cluster to a recent point in time
into a **new, throwaway** cluster in the isolated subnet tier, attach a single
small instance, prove the audit chain still verifies, capture evidence, then
tear the restored cluster down. The live primary is never touched.

> **Never restore in-place over the production primary.** Always
> restore into a fresh cluster. See [`docs/RUNBOOK.md`](../RUNBOOK.md#restoring-from-backup)
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
- [ ] Confirm the prod Aurora cluster has a healthy backup retention
      (`aws rds describe-db-clusters --db-cluster-identifier pharmax-prod-ue1-aurora --query 'DBClusters[0].BackupRetentionPeriod'`
      returns ≥ 35).
- [ ] Note the prod cluster id and the most recent restorable time
      (`aws rds describe-db-clusters --db-cluster-identifier pharmax-prod-ue1-aurora --query 'DBClusters[0].LatestRestorableTime'`).

---

## 1. Provision the restored cluster + instance

The restored cluster lives in the **same VPC + isolated subnet group**
as the source (so it cannot accidentally route to the public internet
or be reached by a stray operator workstation). It uses a distinct
identifier suffixed with `-drill-<YYYYMMDD>`.

Aurora restore is two steps: restore the **cluster** (the storage
volume), then attach a single **instance** so you can connect.

```bash
# Variables (fill these for the drill day):
SRC_CLUSTER_ID="pharmax-prod-ue1-aurora"
RESTORE_TIME="2026-01-15T12:00:00Z"             # within retention window
NEW_CLUSTER_ID="pharmax-prod-ue1-aurora-drill-$(date +%Y%m%d)"
NEW_INSTANCE_ID="${NEW_CLUSTER_ID}-0"
SUBNET_GROUP="pharmax-prod-ue1-db"
DRILL_SG="sg-XXXXXXXXXXXXXXXXX"                  # drill-only SG; NOT the prod app SG

# 1a. Restore the cluster (storage) to the chosen point in time. KMS key,
#     parameter group, and serverlessv2 scaling config are inherited from
#     the source cluster.
aws rds restore-db-cluster-to-point-in-time \
  --source-db-cluster-identifier "$SRC_CLUSTER_ID" \
  --db-cluster-identifier "$NEW_CLUSTER_ID" \
  --restore-to-time "$RESTORE_TIME" \
  --db-subnet-group-name "$SUBNET_GROUP" \
  --vpc-security-group-ids "$DRILL_SG" \
  --enable-cloudwatch-logs-exports postgresql \
  --deletion-protection

aws rds wait db-cluster-available --db-cluster-identifier "$NEW_CLUSTER_ID"

# 1b. Attach a single small instance. Aurora allows mixing instance classes,
#     so a burstable db.t4g.medium keeps the drill cheap regardless of the
#     prod writer's class. (If the source is Serverless v2, use
#     --db-instance-class db.serverless instead.)
aws rds create-db-instance \
  --db-cluster-identifier "$NEW_CLUSTER_ID" \
  --db-instance-identifier "$NEW_INSTANCE_ID" \
  --engine aurora-postgresql \
  --db-instance-class db.t4g.medium \
  --no-publicly-accessible
```

Notes:

- A single instance keeps the drill cheap. The point is restore
  _correctness_, not HA testing.
- `--no-publicly-accessible` is non-negotiable. PHI must remain in the
  isolated tier.
- `--vpc-security-group-ids` references a **drill-only** SG that allows
  inbound 5432 from one developer workstation via a jumpbox / SSM
  session manager. Do NOT reuse the production app SG.
- `--deletion-protection` on the cluster is on so a copy/paste destroy
  doesn't wipe the drill before evidence is captured.

Wait for the instance to come up (typically 10-20 min):

```bash
aws rds wait db-instance-available --db-instance-identifier "$NEW_INSTANCE_ID"
```

---

## 2. Verify

### 2.1 Smoke connection

The restored cluster carries its own AWS-managed master-user secret
(from `manage_master_user_password`). Resolve the writer endpoint and
credentials from the restored cluster, not from the prod secret:

```bash
WRITER=$(aws rds describe-db-clusters --db-cluster-identifier "$NEW_CLUSTER_ID" \
  --query 'DBClusters[0].Endpoint' --output text)
MASTER_SECRET_ARN=$(aws rds describe-db-clusters --db-cluster-identifier "$NEW_CLUSTER_ID" \
  --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
SECRET=$(aws secretsmanager get-secret-value --secret-id "$MASTER_SECRET_ARN" \
  --query SecretString --output text)

PGPASSWORD="$(echo "$SECRET" | jq -r .password)" \
  psql -h "$WRITER" -U "$(echo "$SECRET" | jq -r .username)" -d pharmax \
  -c "SELECT now(), version();"
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

1. The full output of `aws rds restore-db-cluster-to-point-in-time` and
   `aws rds create-db-instance` (including the chosen `RESTORE_TIME`).
2. `aws rds describe-db-clusters --db-cluster-identifier "$NEW_CLUSTER_ID"`
   JSON output (proves storage encrypted with the correct CMK, isolated
   subnet group) and `aws rds describe-db-instances
--db-instance-identifier "$NEW_INSTANCE_ID"` (proves not publicly
   accessible).
3. The `psql` version string from §2.1.
4. The `verify:all` exit code, full stdout, and a SHA-256 of the
   output file.
5. The row-count snapshot from §2.3 with the matching production
   counts for comparison.
6. A screenshot of the RDS console "Configuration" tab on the restored
   cluster, showing storage encryption with the correct CMK alias.
7. The drill captain's sign-off note (1-2 paragraphs: what was tested,
   what passed, what was flagged).

Use the template at the bottom of this file. Do NOT capture any PHI
in screenshots — crop / blur if a query result accidentally exposes a
patient column.

---

## 4. Teardown

Drill clusters must be destroyed within 24 hours. They are a PHI
custody risk every minute they live. Aurora teardown is the reverse of
provision: delete the instance(s) first, then the cluster.

```bash
# 1. Delete the attached instance (no final snapshot at the instance level).
aws rds delete-db-instance \
  --db-instance-identifier "$NEW_INSTANCE_ID" \
  --skip-final-snapshot
aws rds wait db-instance-deleted --db-instance-identifier "$NEW_INSTANCE_ID"

# 2. Disable deletion protection on the now-instance-less cluster.
aws rds modify-db-cluster \
  --db-cluster-identifier "$NEW_CLUSTER_ID" \
  --no-deletion-protection \
  --apply-immediately

# 3. Destroy the cluster (no final snapshot — the drill's purpose was to
#    verify the backup we already have, not to create a new one).
aws rds delete-db-cluster \
  --db-cluster-identifier "$NEW_CLUSTER_ID" \
  --skip-final-snapshot
```

Capture the destroy confirmation into the evidence folder.

Verify it's gone:

```bash
aws rds wait db-cluster-deleted --db-cluster-identifier "$NEW_CLUSTER_ID"
aws rds describe-db-clusters --db-cluster-identifier "$NEW_CLUSTER_ID"
# Should return DBClusterNotFoundFault
```

Close the quarterly drill ticket with a link to the evidence folder.

---

## 5. Helper script

`scripts/operations/run-restore-drill.ts` (npm aliases
`pnpm drill:preflight | drill:provision-commands | drill:verify |
drill:teardown-commands | drill:finalize`) is the canonical executor
for this runbook. It automates the parts that benefit from code and
keeps the destructive AWS calls human-driven — exactly the design the
drill exists to test.

What each phase does (and what it doesn't):

| Phase                | Does                                                                                                                                                                                                                                                                                                                                                                 | Doesn't                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `preflight`          | Read-only `kms:DescribeKey` on the cluster CMK (Enabled + ENCRYPT_DECRYPT + SYMMETRIC_DEFAULT), `rds:DescribeDBClusters` on the source (asserts `BackupRetentionPeriod ≥ 35` and `LatestRestorableTime ≥ --restore-time`), writes `preflight.json` to the drill folder. Exits non-zero on any failure.                                                               | Any write to AWS.                                                                   |
| `provision-commands` | Computes the deterministic drill cluster + instance ids (`<src>-drill-YYYYMMDD` + `-0` suffix), emits `provision.sh` populated with the operator's variables — the operator copy-pastes a generated script rather than hand-substituting variables in the runbook (eliminates the "I typo'd the security group on a drill day" failure mode).                        | Run `provision.sh` for you — it's printed + saved, never executed.                  |
| `verify`             | Connects to the RESTORED cluster (operator points `DATABASE_URL` at the restored endpoint), runs `SELECT version()` (engine version drift = finding), walks `verifyChain` across every org, captures critical-table row counts, writes `verify.json`. Exits non-zero on any chain break or smoke-connect failure.                                                    | The RLS sanity check from §2.4 — that one stays manual (psql under `pharmax_app`).  |
| `teardown-commands`  | Emits `teardown.sh` with the same deterministic ids used at provision (so the destroy targets the same cluster even if days have passed and the operator forgot the suffix).                                                                                                                                                                                         | Run `teardown.sh` for you — same reason as `provision-commands`.                    |
| `finalize`           | Reads every sidecar JSON the prior phases wrote, recovers the cluster ids by parsing `provision.sh`, composes `evidence.{json,md}` matching the [Evidence-capture template](#evidence-capture-template) below. Captain + observer + sign-off + findings are passed via `--captain`, `--observer`, `--sign-off`, `--findings`. Writes both files to the drill folder. | Take a screenshot of the RDS console — operator captures that for the audit folder. |

Default drill folder: `evidence/dr-drills/<YYYY-Q#>/<YYYYMMDD>/`,
override with `--out-dir`. The folder ends up containing:

```text
evidence/dr-drills/2026-Q2/20260615/
├── preflight.json
├── provision.sh
├── verify.json
├── teardown.sh
├── evidence.json
└── evidence.md
```

Phases are **resumable across terminal sessions**: each writes its
own sidecar JSON / shell script, so the drill captain can run
`preflight` in the morning, hand off to a different operator for the
provision step, come back hours later for `verify` after the cluster
is up, and finalize at end of day. The deterministic id naming
(`<src>-drill-YYYYMMDD`) means re-running `provision-commands` or
`teardown-commands` with the same `--now` (or naturally the same UTC
date) computes the same identifiers.

End-to-end drill sequence with the helper:

```bash
# ---- Pre-flight (drill day, morning) -----------------------------
pnpm drill:preflight \
  --source-cluster-id=pharmax-prod-use1-aurora \
  --restore-time=2026-06-15T12:00:00Z \
  --region=us-east-1 \
  --kms-alias=alias/pharmax-prod-use1-rds

# ---- Generate the provision script -------------------------------
pnpm drill:provision-commands \
  --source-cluster-id=pharmax-prod-use1-aurora \
  --restore-time=2026-06-15T12:00:00Z \
  --subnet-group=pharmax-prod-use1-db \
  --drill-sg=sg-XXXXXXXXXXXXXXXXX

# ---- Run the provision script (HUMAN — destructive AWS call) ----
bash evidence/dr-drills/2026-Q2/20260615/provision.sh

# ---- Resolve restored cluster credentials + DATABASE_URL --------
# (the provision.sh tail prints the export line; copy it)

# ---- Verify -----------------------------------------------------
DATABASE_URL='postgres://...restored-endpoint...' \
  PHARMAX_LOCAL_KMS_SEED='...' \
  pnpm drill:verify

# ---- RLS sanity (HUMAN — see §2.4) ------------------------------
psql "$DATABASE_URL" -c 'RESET ALL; SELECT count(*) FROM "patient";'
# expect: 0

# ---- Generate the teardown script -------------------------------
pnpm drill:teardown-commands \
  --source-cluster-id=pharmax-prod-use1-aurora

# ---- Run the teardown script (HUMAN — destructive AWS call) ----
bash evidence/dr-drills/2026-Q2/20260615/teardown.sh

# ---- Compose the final evidence artifact ------------------------
pnpm drill:finalize \
  --captain="Alice Pharmacist" \
  --observer="Bob Engineer" \
  --sign-off="Drill captain confirms the production restore path is exercised end-to-end. Signed: Alice Pharmacist"
```

Required env (verify phase only):

| Env var                  | Purpose                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Postgres connection string of the RESTORED cluster (not the prod primary).                                       |
| `PHARMAX_LOCAL_KMS_SEED` | ≥32 chars; envelope-encryption seed (the script doesn't decrypt anything, but `@pharmax/crypto` boot probes it). |

PHI invariant: the helper script never reads PHI columns. The verify
phase runs `verifyChain` (which hashes audit_log row metadata — no
PHI), counts rows on four tenant-scoped tables, and queries
`SELECT version()`. The composed `evidence.json` is non-PHI by
construction.

If the verify phase reports a chain break or the smoke connect
fails, **do not run the teardown script** — the restored cluster is
now evidence per [§ Failure mode](#failure-mode-the-drill-fails)
below. The `finalize` phase will render `Destroy confirmed: NO` and
embed the failure-mode banner in `evidence.md` so the auditor sees
the right disposition.

---

## Evidence-capture template

Copy this block into the quarterly drill ticket and fill it in.

```text
QUARTERLY AURORA RESTORE DRILL — Q?-YYYY
========================================

Captain:        <name>
Observer:       <name>
Started:        <ISO timestamp>
Completed:      <ISO timestamp>
Drill cluster:  pharmax-prod-ue1-aurora-drill-YYYYMMDD
Drill instance: pharmax-prod-ue1-aurora-drill-YYYYMMDD-0
Source:         pharmax-prod-ue1-aurora
Restore time:   <ISO timestamp within retention window>

§1. Provision
- aws-cli commands:       attached / inline (restore-cluster + create-instance)
- Engine version match:   PASS | FAIL — explain

§2. Verify
- psql smoke connect:     PASS | FAIL
- verify:all exit code:   0 | non-zero
- Audit chain breaks:     none | list
- Row counts vs primary:  attached
- RLS sanity:             PASS | FAIL

§3. Teardown
- Destroy completed:      <ISO timestamp>
- Cluster not found:      PASS | FAIL

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
rows, or the restored cluster can't boot the app:

1. **Stop.** Do not destroy the restored cluster. It is now evidence.
2. File a SEV1 ticket and follow
   [`docs/INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md).
3. Notify the SOC 2 auditor within the contractual window if the
   finding affects the integrity claim.
4. The drill becomes the artifact of the incident — preserve all the
   evidence above plus full Postgres logs and an `EXPLAIN ANALYZE` of
   the verifier's first failing query.

---

## Restoring from Aurora automated backup — incident path

This is the production incident path for "we need this data back from
the most recent restore point" — distinct from the quarterly drill above
(which uses the same primitive in a non-prod context to verify the
machinery still works).

> **Never** restore in-place over the production primary. The recipes
> below always restore into a NEW cluster. The live primary stays
> healthy; the restored cluster is the surgical-recovery scratch space.

### When to use this

- Operator-error data loss: a bad migration, an erroneous bulk update,
  ransomware (vanishingly unlikely on RDS, but the recipe still applies).
- Forensic inspection: an auditor or incident commander wants to compare
  the live primary against a known-good prior point.
- Compliance evidence: the SOC 2 auditor asks "show me a restore at
  this point in time."

### Pre-conditions

- The Aurora backup window covers your target restore point
  (35 days for prod by Terraform default — see
  `infra/terraform/modules/rds/main.tf` `backup_retention_period`).
- The RDS CMK (`alias/pharmax-prod-ue1-rds`) is healthy. Restores
  fail silently with a misconfigured CMK alias.
- You know the precise restore time (ISO timestamp, UTC).
- You have IAM permission to call `rds:RestoreDBClusterToPointInTime`
  (and `rds:CreateDBInstance`) in the target region. Most engineers do
  not — break-glass via the emergency-access procedure if needed.

### Step 1 — pick the restore point

Find the latest restorable time:

```bash
aws rds describe-db-clusters \
  --db-cluster-identifier pharmax-prod-ue1-aurora \
  --query 'DBClusters[0].LatestRestorableTime' \
  --output text
```

Pick a time **just before** the bad event. For "the migration ran at
2026-04-12T14:32:11Z and corrupted data," the restore time is
`2026-04-12T14:31:00Z` — one minute earlier. PITR granularity is the
1-second window between commits.

### Step 2 — provision the restored cluster + instance

```bash
SRC_CLUSTER_ID="pharmax-prod-ue1-aurora"
RESTORE_TIME="2026-04-12T14:31:00Z"
NEW_CLUSTER_ID="pharmax-prod-ue1-aurora-restore-$(date +%Y%m%d%H%M)"
NEW_INSTANCE_ID="${NEW_CLUSTER_ID}-0"
SUBNET_GROUP="pharmax-prod-ue1-db"
RESTORE_SG="sg-XXXXXXXXXXXXXXXXX"  # break-glass-only SG; not the prod app SG

# Restore the cluster (storage) to the point just before the bad event.
aws rds restore-db-cluster-to-point-in-time \
  --source-db-cluster-identifier "$SRC_CLUSTER_ID" \
  --db-cluster-identifier "$NEW_CLUSTER_ID" \
  --restore-to-time "$RESTORE_TIME" \
  --db-subnet-group-name "$SUBNET_GROUP" \
  --vpc-security-group-ids "$RESTORE_SG" \
  --enable-cloudwatch-logs-exports postgresql \
  --deletion-protection
aws rds wait db-cluster-available --db-cluster-identifier "$NEW_CLUSTER_ID"

# Attach an instance sized for the inspection workload (provisioned writer
# class is fine for an incident; use db.serverless if the source is
# Serverless v2).
aws rds create-db-instance \
  --db-cluster-identifier "$NEW_CLUSTER_ID" \
  --db-instance-identifier "$NEW_INSTANCE_ID" \
  --engine aurora-postgresql \
  --db-instance-class db.r6g.large \
  --no-publicly-accessible
```

The same `--no-publicly-accessible` and isolated-subnet constraints from
§1 of the drill apply here. PHI must remain in the isolated tier even on
a restore.

Wait for the instance to come up (10-20 min):

```bash
aws rds wait db-instance-available --db-instance-identifier "$NEW_INSTANCE_ID"
```

### Step 3 — verify

Per the drill recipe in §2 above (smoke connect, audit chain integrity,
row counts, RLS sanity). The restored DB has the same schema and the
same RLS / FORCE RLS / `pharmax_app` role configuration. The audit
chain head should match the live primary at the moment of `RESTORE_TIME`.

### Step 4 — surgical migrate the affected data

Now the production-incident-specific work. Inspect the restored data,
identify the rows you need to recover, and migrate them into the live
primary. **Never** swap the live primary for the restored cluster — the
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

The restored cluster is a PHI custody risk every minute it lives.
Delete the instance first, then the cluster:

```bash
aws rds delete-db-instance \
  --db-instance-identifier "$NEW_INSTANCE_ID" \
  --skip-final-snapshot
aws rds wait db-instance-deleted --db-instance-identifier "$NEW_INSTANCE_ID"

aws rds modify-db-cluster \
  --db-cluster-identifier "$NEW_CLUSTER_ID" \
  --no-deletion-protection \
  --apply-immediately

aws rds delete-db-cluster \
  --db-cluster-identifier "$NEW_CLUSTER_ID" \
  --skip-final-snapshot
```

Verify deletion:

```bash
aws rds wait db-cluster-deleted --db-cluster-identifier "$NEW_CLUSTER_ID"
```

### Step 6 — postmortem

Same evidence template as the quarterly drill (§3 evidence-capture
template). Add an "Incident context" section describing what triggered
the restore, the chosen `RESTORE_TIME`, and the `RecoverFromBackup`
commands executed against the live primary.

### Cross-region restore (DR scenario)

If the source region itself is offline, point the
`copy-db-cluster-snapshot` + `restore-db-cluster-from-snapshot` recipes
in `docs/RUNBOOK.md` § "Disaster recovery: regional failover" instead.
The cross-region path is meaningfully different because the cluster
snapshot must be copied across regions before restore, and the restored
cluster lives in a different KMS context.

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
aws rds describe-db-cluster-snapshots \
  --db-cluster-identifier pharmax-prod-ue1-aurora \
  --query 'reverse(sort_by(DBClusterSnapshots, &SnapshotCreateTime))[0].KmsKeyId' \
  --output text
```

The returned ARN should match
`infra/terraform/environments/prod/us-east-1` output `kms_rds_key_arn`.
Any other value is a finding.

### Provisioning the cross-region snapshot copy

The cross-region snapshot copy schedule is **not** managed by the
database module today — Aurora native cross-region cluster-snapshot copy
is per-snapshot on-demand, not continuous. The DR runbook
(`docs/RUNBOOK.md` § Disaster recovery: regional failover, Step 3) shows
the on-demand copy command.

A planned enhancement is **Aurora Global Database** (continuous,
low-RPO cross-region replication — the clean path per ADR 0029/0022),
or, as an interim, an EventBridge schedule + Lambda that copies a daily
cluster snapshot cross-region. When that lands, it is owned by
`infra/terraform/modules/rds/` (or a new `modules/dr/` if it grows
beyond one resource).
