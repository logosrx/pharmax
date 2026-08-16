# `<prefix>-ecs-<svc>-mem-high` (web / worker / print-agent)

> One alarm per service (`for_each` over web, worker, print-agent).
> Commands below use the primary-region prefix `pharmax-prod-ue1`.

## What fired and what it means

- **Metric:** `MemoryUtilization` (`AWS/ECS`, dimensions `ClusterName` +
  `ServiceName`), Average.
- **Threshold:** > 85%, **3 × 5-minute periods** (15 minutes sustained).
  Missing data does not breach.
- **User-visible symptom:** none yet. The danger is the next step: a task
  that actually exhausts its memory is **OOM-killed and replaced**, which
  drops the requests/jobs it was holding and surfaces on the paging
  running-count alarm. Memory is the more urgent of the two utilization
  warnings for exactly that reason.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`ecs_memory_high`).

## Severity + who is paged

**Warning** → `pharmax-prod-ue1-alerts-warning` SNS topic → ticket queue /
shift mailbox. At 85% the useful action is a task-definition memory bump,
which is a change, not an incident.

## First 5 minutes

1. **Steady climb or plateau?**

   ```bash
   aws cloudwatch get-metric-statistics --namespace AWS/ECS \
     --metric-name MemoryUtilization --statistics Average --period 300 \
     --dimensions Name=ClusterName,Value=pharmax-prod-ue1 Name=ServiceName,Value=pharmax-prod-ue1-worker \
     --start-time $(date -u -v-6H +%Y-%m-%dT%H:%M:%SZ) --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)
   ```

   A sawtooth (climb → drop) means tasks are already being OOM-killed and
   recycled — treat with urgency. A plateau is a sizing problem.

2. **Heap view:** Grafana _Pharmax · Platform Health_ →
   **“Heap utilization (used / limit)”** — heap climbing without bound is a
   leak; heap flat with container memory high points at non-heap usage
   (buffers, native deps).
3. **Any recent kills?**

   ```bash
   aws ecs describe-services --cluster pharmax-prod-ue1 \
     --services pharmax-prod-ue1-worker --query 'services[0].events[:10]'
   ```

   Look for "began draining" / "has stopped" events, then read the stopped
   task's `stoppedReason` (`OutOfMemoryError: Container killed due to
memory usage` is explicit).

4. Correlate with the last deploy — a leak that arrived with a release
   climbs from deploy time.

## Likely causes (ranked)

1. **A memory leak in the latest release** — steady climb from deploy time,
   restarts reset it.
2. **Undersized task definition for grown load** — plateau near the limit,
   no leak shape.
3. **A large batch job in worker** (bulk outbox drain, report render,
   label PDF burst) legitimately peaking.
4. **Heavy request payloads on web** (large document uploads) transiently
   spiking a few tasks.

## Mitigations

- **Sizing fix (the real one):** raise `ecs_<svc>_memory` in the env-region
  tfvars via the reviewer-gated Terraform apply. File the ticket with the
  metric graph.
- **Restart the service** (human decision — resets a leak's clock, loses
  the diagnostic state):

  ```bash
  aws ecs update-service --cluster pharmax-prod-ue1 \
    --service pharmax-prod-ue1-worker --force-new-deployment
  ```

  A justified 03:00 action if the sawtooth shows OOM kills are already
  dropping work.

- If OOM kills are hitting **web**, watch [ecs-running-low](ecs-running-low.md)
  and [alb-5xx-rate](alb-5xx-rate.md) — they page if it becomes an outage.

## Escalation

Ticket, same day. Escalate if the sawtooth pattern shows repeated OOM kills
(work is being dropped) or the paging alarms join. Declaration mechanics:
the [alerting runbook](../alerting.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) — check
  `StateReason`.
- A deploy or a known large batch job in progress; a short spike that
  self-resolves is the system working.
