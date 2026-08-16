# `<prefix>-rds-connections-high`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.
> Substitute `pharmax-prod-uw2` in the DR region.

## What fired and what it means

- **Metric:** `DatabaseConnections` (`AWS/RDS`, dimension
  `DBInstanceIdentifier` = the Aurora **writer**), Average.
- **Threshold:** > 200 (`rds_connection_threshold`), **2 × 5-minute
  periods**. Missing data does not breach.
- **User-visible symptom:** none yet — but the wall is close. When the
  writer hits `max_connections`, **new** connections are refused, which
  takes out web and worker together and looks like a total outage: every
  save, every verification, every background side effect fails at once.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`rds_connections_high`).

## Severity + who is paged

**Critical** → `pharmax-prod-ue1-alerts-critical` SNS topic → paging
provider + on-call mailbox. There is a real 03:00 lever: terminate leaked
sessions or restart the leaking service.

## First 5 minutes

1. **Working connections or leaked ones?** Connect (read-only) and run:

   ```sql
   SELECT state, count(*) FROM pg_stat_activity GROUP BY state ORDER BY 2 DESC;

   SELECT pid, state, now() - state_change AS idle_for, left(query, 80)
   FROM pg_stat_activity
   WHERE state = 'idle in transaction'
   ORDER BY state_change
   LIMIT 20;
   ```

   A pile of `idle in transaction` is a code path that opened a transaction
   and never closed it — that is the leak.

2. **Who is holding them?** Group by application/client:

   ```sql
   SELECT usename, application_name, count(*)
   FROM pg_stat_activity GROUP BY 1, 2 ORDER BY 3 DESC;
   ```

   Web selects the RLS-subject `pharmax_app` role; worker selects
   `pharmax_system` — the role names tell you which service is leaking.

3. **Did a scale-out cause it legitimately?**

   ```bash
   aws ecs describe-services --cluster pharmax-prod-ue1 \
     --services pharmax-prod-ue1-web pharmax-prod-ue1-worker \
     --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount}'
   ```

   Web autoscales 3→20; each task holds a pool. 20 tasks × pool size can
   legitimately exceed 200 — check headroom against `max_connections`, not
   the absolute number.

4. **Grafana:** _Pharmax · Platform Health_ → **“Postgres pool
   utilization”**; CloudWatch dashboard `pharmax-prod-ue1-overview` →
   “Aurora PostgreSQL” panel.

## Likely causes (ranked)

1. **An `idle in transaction` leak** — a code path (usually a new one)
   holding transactions open.
2. **Web scaled out under load** and the aggregate pool exceeded 200 —
   legitimate, but the threshold or pool sizing needs a ticket.
3. **A migration/backfill/restore drill** deliberately holding connections.
4. **A stuck job in worker** holding pool connections while wedged on a
   downstream (check the outbox alarms).

## Mitigations

- **Terminate the oldest offenders** (safe, immediate headroom):

  ```sql
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE state = 'idle in transaction'
    AND now() - state_change > interval '10 minutes';
  ```

- **Restart the leaking service** (human decision — brief capacity dip, and
  it destroys the diagnostic state):

  ```bash
  aws ecs update-service --cluster pharmax-prod-ue1 \
    --service pharmax-prod-ue1-web --force-new-deployment
  ```

- Raising `max_connections` / instance class is a reviewer-gated Terraform
  apply — not a solo action.

## Escalation

- SEV2 while connections climb but the app serves.
- **SEV1 the moment [`alb-5xx-rate`](alb-5xx-rate.md) joins** — that
  combination is the wall being hit.
- Declare per the [alerting runbook](../alerting.md) and
  [incident response](../../INCIDENT_RESPONSE.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) — check
  `StateReason`
  ([alerting runbook § Proving the pipe works](../alerting.md#proving-the-pipe-works)).
- A migration, backfill, or restore drill deliberately holding connections
  during a planned window.
- A legitimate traffic peak with plenty of headroom below `max_connections`
  — the fix is a threshold/tfvars ticket, not an incident.
