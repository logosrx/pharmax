# `<prefix>-ecs-<svc>-cpu-high` (web / worker / print-agent)

> One alarm per service (`for_each` over web, worker, print-agent).
> Commands below use the primary-region prefix `pharmax-prod-ue1`.
> Substitute the service and region you were alerted for.

## What fired and what it means

- **Metric:** `CPUUtilization` (`AWS/ECS`, dimensions `ClusterName` +
  `ServiceName`), Average.
- **Threshold:** > 80%, **3 × 5-minute periods** (15 minutes sustained).
  Missing data does not breach.
- **User-visible symptom:** usually none. For **web**, sustained CPU is
  normally the autoscaling policy working (min 3 / max 20 on CPU). For
  **worker**, it means side-effect processing (outbox drain, label
  rendering, notifications) is running hot — a backlog being chewed through
  or a capacity-planning signal. For **print-agent**, unusual: label
  rendering load or a crash-loop burning CPU.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`ecs_cpu_high`).

## Severity + who is paged

**Warning** → `pharmax-prod-ue1-alerts-warning` SNS topic → ticket queue /
shift mailbox. If it degrades into an outage, the **5xx** and
**running-count** alarms page.

## First 5 minutes

1. **For web: did autoscaling react?**

   ```bash
   aws ecs describe-services --cluster pharmax-prod-ue1 \
     --services pharmax-prod-ue1-web \
     --query 'services[0].{desired:desiredCount,running:runningCount,events:events[:5]}'
   ```

   `desiredCount` should have risen. Pinned at 20 with CPU still high =
   genuine saturation.

2. **For worker: is this a backlog draining?** Grafana _Pharmax · Workflow
   Overview_ → **“Queue depth by stage”**; CloudWatch dashboard
   `pharmax-prod-ue1-overview` → “Event outbox backlog (custom)” panel.
   Depth falling + CPU high = the system working off a backlog. Leave it.
3. **Process-level view:** Grafana _Pharmax · Platform Health_ →
   **“CPU usage (process_cpu_utilization)”** and
   **“Event-loop p99 lag (seconds)”** — event-loop lag with high CPU means
   a synchronous hot path, not just volume.
4. Recent errors from the hot service:

   ```bash
   aws logs start-query --log-group-name /ecs/pharmax-prod-ue1/worker \
     --start-time $(($(date +%s) - 1800)) --end-time $(date +%s) \
     --query-string 'fields @timestamp, @message | filter @message like /"level":"error"/ | sort @timestamp desc | limit 30'
   ```

## Likely causes (ranked)

1. **Web:** legitimate traffic peak — autoscaling absorbing it (working as
   designed) or pinned at max (capacity ticket).
2. **Worker:** a large outbox backlog or notification burst being worked
   off; check the outbox depth panel before reading further.
3. **A hot loop from the latest release** — CPU stepped up at deploy time
   and stays up regardless of load.
4. **Print-agent:** crash-looping on boot (it must resolve a workstation
   and reach a Zebra printer) — the restarts burn CPU; see
   [ecs-print-agent-running-low](ecs-print-agent-running-low.md).

## Mitigations

- Usually **a ticket with a task-definition sizing change** as the remedy
  (`ecs_<svc>_cpu` in the env tfvars, reviewer-gated apply).
- Worker/print-agent have **no autoscaling** — a human may decide to scale
  manually for a burst:

  ```bash
  aws ecs update-service --cluster pharmax-prod-ue1 \
    --service pharmax-prod-ue1-worker --desired-count 2
  ```

  **Caveat:** the ECS service ignores `desired_count` drift by design;
  record the change in the ticket so the tfvars follow.

- Raising `ecs_web_max_count`: Terraform change, reviewer-gated.

## Escalation

Only if it degrades: 5xx rising → [alb-5xx-rate](alb-5xx-rate.md); tasks
dying → [ecs-running-low](ecs-running-low.md); outbox age climbing →
[outbox-oldest-age-high](outbox-oldest-age-high.md). Declaration mechanics:
the [alerting runbook](../alerting.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) — check
  `StateReason`.
- A deploy in progress, or a short self-resolving spike, is the system
  working. Fifteen sustained minutes filters most of these; if it fires
  during every deploy, the deploy itself deserves a look.
