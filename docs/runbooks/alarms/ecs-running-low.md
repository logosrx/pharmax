# `<prefix>-ecs-web-running-low` / `<prefix>-ecs-worker-running-low`

> Two alarms, one per paging-availability service (web, worker).
> Commands below use the primary-region prefix `pharmax-prod-ue1`.

## What fired and what it means

- **Metric:** `RunningTaskCount` (`ECS/ContainerInsights`, dimensions
  `ClusterName` + `ServiceName`), Minimum.
- **Threshold:** < 1, **2 × 1-minute periods**. **Missing data breaches**
  — deliberately: a service whose metric disappeared is not a service that
  is fine.
- **User-visible symptom:**
  - **web:** total outage. No pharmacist can type, verify, or ship; the
    partner API is down; the console is unreachable.
  - **worker:** invisible-but-accruing outage. The event-outbox drain,
    label rendering, notifications, and SLA timers all stop **while orders
    keep arriving**. The console looks fine; the damage lands later as an
    SLA-breach storm and an outbox backlog.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`ecs_running_count_low`).

## Severity + who is paged

**Critical** → `pharmax-prod-ue1-alerts-critical` SNS topic → paging
provider + on-call mailbox. Zero running tasks IS the outage.

## First 5 minutes

1. **Why are tasks not running?**

   ```bash
   aws ecs describe-services --cluster pharmax-prod-ue1 \
     --services pharmax-prod-ue1-web \
     --query 'services[0].{desired:desiredCount,running:runningCount,events:events[:5]}'
   ```

   The `events` array names the reason: failed health checks, capacity, or
   a task that will not boot.

2. **For a boot failure, read the corpse:**

   ```bash
   aws ecs list-tasks --cluster pharmax-prod-ue1 \
     --service-name pharmax-prod-ue1-web --desired-status STOPPED --max-items 3

   aws ecs describe-tasks --cluster pharmax-prod-ue1 --tasks <task-arn> \
     --query 'tasks[0].{stoppedReason:stoppedReason,containers:containers[].{name:name,exitCode:exitCode,reason:reason}}'
   ```

3. **Last words in the logs:**

   ```bash
   aws logs start-query --log-group-name /ecs/pharmax-prod-ue1/web \
     --start-time $(($(date +%s) - 1800)) --end-time $(date +%s) \
     --query-string 'fields @timestamp, @message | sort @timestamp desc | limit 50'
   ```

   A task that cannot reach Secrets Manager or KMS at boot **fails closed
   by design** — see
   [RUNBOOK § KMS boot validation failures](../../RUNBOOK.md#rotating-a-kms-data-key).

4. **Was this a deploy?** The **deployment circuit breaker**
   (`enable = true, rollback = true` on all three services) rolls a failed
   deployment back automatically. Check which task definition is actually
   running before assuming your rollback fixed anything — and remember the
   deploy matrix rolls services independently, so a partial failure leaves
   **mixed versions** in production.
5. **Grafana:** _Pharmax · Platform Health_ → “Request rate (per second, by
   service)” (web gone quiet?); _Pharmax · Workflow Overview_ → “Queue depth
   by stage” (worker damage accruing?).

## Likely causes (ranked)

1. **A bad release failing health checks** — circuit breaker already
   rolling back; the alarm fires during the gap.
2. **Boot-time dependency failure** — Secrets Manager, KMS, or the database
   unreachable; tasks fail closed and crash-loop.
3. **Capacity** — Fargate capacity or subnet IP exhaustion (rare; the
   service events say so explicitly).
4. **OOM kill loop** — see [ecs-mem-high](ecs-mem-high.md); the sawtooth
   there precedes the zero here.
5. **Someone set desiredCount to 0** — the service events record who/what.

## Mitigations

- **Force a fresh deployment** (safe first move for a wedged service):

  ```bash
  aws ecs update-service --cluster pharmax-prod-ue1 \
    --service pharmax-prod-ue1-web --force-new-deployment
  ```

- **Roll back a bad release** — human-gated:
  [RUNBOOK § Rolling back a deploy](../../RUNBOOK.md#rolling-back-a-deploy).
  Wake the deploy approver **now**; the dispatch waits for them.
- **After worker recovers, the work it missed is still missing.** Work
  [RUNBOOK § Outbox drain stuck or backed up](../../RUNBOOK.md#outbox-drain-stuck-or-backed-up)
  and
  [RUNBOOK § SLA breach storm](../../RUNBOOK.md#sla-breach-storm--emergency-bucket-walkthrough).
  Recovery of the process is not recovery of the work.

## Escalation

- **web: SEV1 immediately.**
- **worker: SEV1 if down more than ~15 minutes** — the outbox backlog and
  SLA timers are why the clock matters.
- Declare per [incident response](../../INCIDENT_RESPONSE.md); paging and
  approver mechanics in the [alerting runbook](../alerting.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) — check
  `StateReason`.
- A healthy rolling deploy does **not** trip this alarm (it needs two
  consecutive minutes below one task, and the deploy config keeps
  minimum-healthy at 100%). If it fires during a routine deploy, the deploy
  is not healthy — treat it as real.
- Missing data breaching means a Container Insights outage or a disabled
  metric pipeline also fires this alarm. Verify with
  `aws ecs describe-services` before assuming tasks are actually down —
  but verify, do not assume.
