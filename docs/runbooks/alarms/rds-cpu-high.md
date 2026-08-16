# `<prefix>-rds-cpu-high`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.
> Substitute `pharmax-prod-uw2` in the DR region.

## What fired and what it means

- **Metric:** `CPUUtilization` (`AWS/RDS`, dimension `DBInstanceIdentifier`
  = the Aurora **writer**), Average.
- **Threshold:** > 80% (`rds_cpu_threshold_percent`), **2 × 5-minute
  periods** (10 minutes sustained). Missing data does not breach.
- **User-visible symptom:** usually none yet — this is the capacity signal
  _before_ users feel it. If it degrades, it shows up as slow saves and
  queue loads (`alb-target-p99`), then as failures via the connection /
  memory alarms.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`rds_cpu_high`).

## Severity + who is paged

**Warning** → `pharmax-prod-ue1-alerts-warning` SNS topic → ticket queue /
shift mailbox. Deliberate: the 03:00 lever (resize the instance class) needs
a reviewer-gated Terraform apply anyway, and the cliffs it leads to have
their own **critical** alarms (connections, freeable memory).

## First 5 minutes

1. **Performance Insights → top SQL by load** on the writer. One dominant
   statement = missing index or a query regression from the last release;
   broad load across many statements = genuine growth.
2. Confirm the shape from the CLI:

   ```bash
   aws cloudwatch get-metric-statistics --namespace AWS/RDS \
     --metric-name CPUUtilization --statistics Average --period 300 \
     --dimensions Name=DBInstanceIdentifier,Value=$(aws rds describe-db-instances \
       --query 'DBInstances[?contains(DBInstanceIdentifier, `pharmax-prod-ue1`)] | [0].DBInstanceIdentifier' --output text) \
     --start-time $(date -u -v-3H +%Y-%m-%dT%H:%M:%SZ) --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)
   ```

   A step change points at a deploy or a job start time; a slow ramp points
   at load growth.

3. **Grafana:** _Pharmax · Platform Health_ → **“Postgres pool
   utilization”** (is the app feeling it?); _Pharmax · Workflow Overview_ →
   **“Orders completing each stage (per minute, by tenant)”** (is this a
   legitimate traffic peak?).
4. Check the CloudWatch dashboard `pharmax-prod-ue1-overview`, “Aurora
   PostgreSQL” panel — CPU alongside connections and memory tells you how
   close the real cliffs are.

## Likely causes (ranked)

1. **A query regression or missing index** from the latest release — one
   statement dominating Performance Insights.
2. **A reporting/analytics query on the writer** — reports must use
   `REPORTING_DATABASE_URL` (the reader); one escaping onto the writer is a
   bug worth a ticket naming the query.
3. **A migration, backfill, or `ANALYZE`** running as planned work.
4. **Genuine load growth** — CPU tracks order volume; the remedy is
   capacity planning, not an incident.

## Mitigations

- Usually **file the ticket** with the offending statement attached.
- A runaway analytical query: human decision to
  `SELECT pg_terminate_backend(<pid>)` after confirming it is not a
  migration.
- Instance-class resize: Terraform change (`rds_instance_class` /
  ACU ceiling in the env tfvars) through the reviewer-gated apply — a
  20-minute-plus path with a human in it, never a solo 03:00 action.

## Escalation

This alarm becomes an incident **by way of** `rds-connections-high` or
`rds-freeable-memory-low`, which page. If either joins, work that runbook
([rds-connections-high](rds-connections-high.md),
[rds-freeable-memory-low](rds-freeable-memory-low.md)) and declare per the
[alerting runbook](../alerting.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) can force
  this alarm — check `StateReason`
  ([alerting runbook § Proving the pipe works](../alerting.md#proving-the-pipe-works)).
- A migration/backfill window or a known traffic peak with unaffected
  latency is the system working, not failing.
