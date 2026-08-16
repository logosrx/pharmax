# Per-alarm runbooks

One file per CloudWatch alarm: the 5-minute "what do I do when this
fires". Broader context — routing, tiers, the fire-drill procedure, what
to do when **no** alert arrived — is the
[alerting runbook](../alerting.md); procedures these runbooks link into
are [`docs/RUNBOOK.md`](../../RUNBOOK.md).

Alarm names below are suffixes; the deployed name is
`<prefix>-<suffix>` where `<prefix>` is `pharmax-prod-ue1` (primary) or
`pharmax-prod-uw2` (DR).

## Index

| Alarm                                            | Severity     | Meaning (one line)                                                               | Runbook                                                          |
| ------------------------------------------------ | ------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `alb-5xx-rate`                                   | **critical** | Users are getting errors right now: > 1% of requests returning 5xx.              | [alb-5xx-rate.md](alb-5xx-rate.md)                               |
| `rds-connections-high`                           | **critical** | Writer nearing the connection wall; hitting it takes out web + worker together.  | [rds-connections-high.md](rds-connections-high.md)               |
| `rds-freeable-memory-low`                        | **critical** | Writer < 1 GiB freeable memory; minutes from an unplanned failover.              | [rds-freeable-memory-low.md](rds-freeable-memory-low.md)         |
| `ecs-web-running-low` / `ecs-worker-running-low` | **critical** | Zero running tasks — web down is the outage; worker down is silent queue damage. | [ecs-running-low.md](ecs-running-low.md)                         |
| `audit-chain-integrity`                          | **critical** | The tamper-evident audit chain broke for ≥ 1 tenant: a bug or a person.          | [audit-chain-integrity.md](audit-chain-integrity.md)             |
| `outbox-stalled`                                 | **critical** | Oldest undispatched outbox row > 1 h: every async side effect is queued.         | [outbox-stalled.md](outbox-stalled.md)                           |
| `synthetics-heartbeat-failed`                    | **critical** | The public health endpoint is unreachable from the internet (canary failing).    | [synthetics-heartbeat-failed.md](synthetics-heartbeat-failed.md) |
| `alb-target-p99`                                 | warning      | Web p99 > 2 s for 15 min: slow, not stopped.                                     | [alb-target-p99.md](alb-target-p99.md)                           |
| `rds-cpu-high`                                   | warning      | Writer CPU > 80%: capacity signal before users feel it.                          | [rds-cpu-high.md](rds-cpu-high.md)                               |
| `rds-replica-lag`                                | warning      | Reader > 30 s behind: stale reports, dispensing unaffected.                      | [rds-replica-lag.md](rds-replica-lag.md)                         |
| `ecs-<svc>-cpu-high`                             | warning      | A service running hot; web autoscaling normally absorbs it.                      | [ecs-cpu-high.md](ecs-cpu-high.md)                               |
| `ecs-<svc>-mem-high`                             | warning      | Memory > 85%: next stop is an OOM kill, which the paging alarms catch.           | [ecs-mem-high.md](ecs-mem-high.md)                               |
| `ecs-print-agent-running-low`                    | warning      | No print agent → no vial labels (business-hours problem; conditional alarm).     | [ecs-print-agent-running-low.md](ecs-print-agent-running-low.md) |
| `outbox-oldest-age-high`                         | warning      | Oldest undispatched outbox row > 15 min: some side effect is that late.          | [outbox-oldest-age-high.md](outbox-oldest-age-high.md)           |
| `outbox-dead-rows`                               | warning      | A side effect was permanently missed; stays in ALARM until admin replay.         | [outbox-dead-rows.md](outbox-dead-rows.md)                       |

Coverage: 14 `aws_cloudwatch_metric_alarm` resources in
[`modules/cloudwatch`](../../../infra/terraform/modules/cloudwatch/main.tf)
(the per-service `for_each` resources share one runbook each) plus 1 in
[`modules/synthetics`](../../../infra/terraform/modules/synthetics/main.tf)
→ 15 runbooks.

## Maintenance rule

**A new `aws_cloudwatch_metric_alarm` in Terraform requires a runbook in
this directory — in the same PR.** No exceptions: an alarm without a
runbook pages a human and then leaves them guessing, which is how a
rotation learns to ignore its pager. The reviewer checklist for any PR
touching alarm resources:

1. A `docs/runbooks/alarms/<alarm-slug>.md` exists with the standard
   sections (what fired / severity / first 5 minutes / likely causes /
   mitigations / escalation / false positives).
2. The index table above has a row for it.
3. If the alarm lives in a new Terraform file, that file is listed in
   `ALARM_MODULE_FILES` in
   [`scripts/check-alarm-actions.ts`](../../../scripts/check-alarm-actions.ts)
   so the severity-wiring guard covers it.

Renaming or retiring an alarm follows the same rule in reverse: update or
delete the runbook and the index row in the same PR.
