# `<prefix>-rds-replica-lag`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.
> Substitute `pharmax-prod-uw2` in the DR region.

## What fired and what it means

- **Metric:** `AuroraReplicaLag` (`AWS/RDS`, dimension
  `DBClusterIdentifier` — cluster level; Aurora reports it in
  **milliseconds**), Maximum.
- **Threshold:** > 30,000 ms (`rds_replica_lag_threshold_ms`, 30 s),
  **2 × 1-minute periods**. Missing data does not breach.
- **User-visible symptom:** stale reports. The reader only backs
  `REPORTING_DATABASE_URL`, so dispensing is unaffected — but anyone acting
  on a report from this window may be looking at numbers 30+ seconds old.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`rds_replica_lag`).

## Severity + who is paged

**Warning** → `pharmax-prod-ue1-alerts-warning` SNS topic → ticket queue /
shift mailbox. If the lag is caused by writer overload, the **writer's own
critical alarms** are the ones that wake someone.

## First 5 minutes

1. **Is the writer also alarming?** Lag is usually a _symptom_ of writer
   pressure. Check `rds-cpu-high`, `rds-connections-high`,
   `rds-freeable-memory-low` states:

   ```bash
   aws cloudwatch describe-alarms --alarm-name-prefix pharmax-prod-ue1-rds \
     --query 'MetricAlarms[].{name:AlarmName,state:StateValue}'
   ```

2. **Trend:**

   ```bash
   aws cloudwatch get-metric-statistics --namespace AWS/RDS \
     --metric-name AuroraReplicaLag --statistics Maximum --period 60 \
     --dimensions Name=DBClusterIdentifier,Value=$(aws rds describe-db-clusters \
       --query 'DBClusters[?contains(DBClusterIdentifier, `pharmax-prod-ue1`)] | [0].DBClusterIdentifier' --output text) \
     --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ) --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)
   ```

   Already draining = a batch write landed; still climbing = keep looking.

3. **A long read query on the replica** can block apply:

   ```sql
   -- on the READER endpoint
   SELECT pid, state, now() - query_start AS running_for, left(query, 80)
   FROM pg_stat_activity
   WHERE state = 'active'
   ORDER BY query_start
   LIMIT 10;
   ```

4. CloudWatch dashboard `pharmax-prod-ue1-overview` → “Aurora PostgreSQL”
   panel shows lag next to writer CPU/connections.

## Likely causes (ranked)

1. **Writer write pressure** — bulk import, migration, or a traffic peak;
   the replica applies as fast as it can.
2. **A long-running analytical query on the reader** blocking apply.
3. **Reader instance undersized** relative to the writer's write rate —
   chronic low-grade lag, a capacity ticket.

## Mitigations

- Usually **watch it drain** and file the ticket.
- Kill a blocking reader query (safe — reporting only):
  `SELECT pg_terminate_backend(<pid>)` on the reader.
- **Tell report consumers.** Anyone reading SLA/billing reports from the
  lag window may act on stale numbers — a one-line note in the ops channel
  is a real mitigation here.

## Escalation

Ticket. Escalate only via the writer's alarms — if the writer is the cause,
work [that runbook](rds-cpu-high.md) instead. Declaration mechanics: the
[alerting runbook](../alerting.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) — check
  `StateReason`.
- A large batch write (bulk import, migration) just landed and lag is
  already draining — the system catching up, not failing.
