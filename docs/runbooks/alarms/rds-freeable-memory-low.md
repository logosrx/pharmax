# `<prefix>-rds-freeable-memory-low`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.
> Substitute `pharmax-prod-uw2` in the DR region.

## What fired and what it means

- **Metric:** `FreeableMemory` (`AWS/RDS`, dimension `DBInstanceIdentifier`
  = the Aurora **writer**), Average.
- **Threshold:** < 1 GiB (`rds_freeable_memory_low_threshold_bytes`,
  default `1073741824`), **2 × 5-minute periods**. Missing data does not
  breach.
- **User-visible symptom:** none yet, but minutes away from a bad one: a
  writer that exhausts memory starts swapping and then **fails over
  unplanned**, dropping every in-flight transaction — mid-dispense
  included. (Aurora has no `FreeStorageSpace` metric — storage auto-scales —
  so writer memory is the capacity cliff this stack watches.)

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`rds_freeable_memory_low`).

## Severity + who is paged

**Critical** → `pharmax-prod-ue1-alerts-critical` SNS topic → paging
provider + on-call mailbox. A human can kill the offending workload or fail
over deliberately; both beat finding out from a pharmacist.

## First 5 minutes

1. **Performance Insights on the writer**, sorted by memory-heavy activity:
   look for a large sort/hash join, or a reporting query that escaped onto
   the writer. Confirm `REPORTING_DATABASE_URL` points at the **reader**
   endpoint.
2. **Trend, not snapshot:**

   ```bash
   aws cloudwatch get-metric-statistics --namespace AWS/RDS \
     --metric-name FreeableMemory --statistics Average --period 300 \
     --dimensions Name=DBInstanceIdentifier,Value=$(aws rds describe-db-instances \
       --query 'DBInstances[?contains(DBInstanceIdentifier, `pharmax-prod-ue1`)] | [0].DBInstanceIdentifier' --output text) \
     --start-time $(date -u -v-3H +%Y-%m-%dT%H:%M:%SZ) --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)
   ```

   Falling fast = act now. Recovering = the offending query already
   finished; watch it.

3. Find memory-hungry sessions:

   ```sql
   SELECT pid, usename, state, now() - query_start AS running_for, left(query, 80)
   FROM pg_stat_activity
   WHERE state = 'active'
   ORDER BY query_start
   LIMIT 20;
   ```

4. CloudWatch dashboard `pharmax-prod-ue1-overview` → “Aurora PostgreSQL”
   panel: memory alongside CPU and connections — three falling together is
   overload, memory alone is one bad query.

## Likely causes (ranked)

1. **One memory-heavy query** — a large sort or hash join, usually
   analytical, usually escaped onto the writer instead of the reader.
2. **Genuine buffer-cache pressure from load growth** — memory declines
   slowly over days, not minutes.
3. **The instance was resized down** and the 1 GiB threshold is simply
   wrong for the new class — a tfvars fix, not an incident.
4. **Connection pile-up** (each connection has a work_mem budget) — check
   whether [`rds-connections-high`](rds-connections-high.md) fired too.

## Mitigations

- **Stop the offending workload:** `SELECT pg_terminate_backend(<pid>)` on
  the memory-heavy session — safe once you have confirmed it is not a
  migration.
- **Deliberate failover** (two-engineer decision, never solo): if memory
  keeps falling after the workload is stopped, a controlled
  `aws rds failover-db-cluster` in a quiet moment beats an uncontrolled one
  mid-dispense.
- Instance-class / ACU-ceiling change: reviewer-gated Terraform apply.

## Escalation

SEV2 on firing. Upgrade to SEV1 if memory keeps falling after mitigation or
a failover happens. The failover decision needs a second engineer — page
them via the [alerting runbook](../alerting.md) escalation path.

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) — check
  `StateReason`
  ([alerting runbook § Proving the pipe works](../alerting.md#proving-the-pipe-works)).
- A one-off analytical query that already finished, with the metric
  recovering on its own.
- A recent resize-down making the fixed 1 GiB threshold wrong for the new
  instance class — file the tfvars ticket
  (`rds_freeable_memory_low_threshold_bytes`).
