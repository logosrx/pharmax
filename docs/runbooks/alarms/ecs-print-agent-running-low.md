# `<prefix>-ecs-print-agent-running-low`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.

## What fired and what it means

- **Metric:** `RunningTaskCount` (`ECS/ContainerInsights`, dimensions
  `ClusterName` + `ServiceName` = print-agent), Minimum.
- **Threshold:** < 1, **2 × 1-minute periods**. **Missing data breaches.**
- **Conditional existence:** this alarm is only created when the stack
  intends the print agent to run
  (`print_agent_running_alarm_enabled = ecs_print_agent_desired_count > 0`).
  Production currently sets `ecs_print_agent_desired_count = 0` (no
  physical pharmacy site yet), so **this alarm does not exist in production
  today**. If it fired, a stack where the agent is expected to run has lost
  it.
- **User-visible symptom:** no vial labels print. Dispensing stops on the
  pharmacy floor — during business hours. FILL-stage orders queue behind
  the printer.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`ecs_print_agent_running_low`).

## Severity + who is paged

**Warning** → `pharmax-prod-ue1-alerts-warning` SNS topic → ticket queue /
shift mailbox. Deliberate: a dead print agent stops label printing, but
there is nothing useful anyone can do about it at 03:00 in a closed
pharmacy. The morning shift reads the warning mailbox before it touches a
vial.

## First 5 minutes

1. **Is it meant to be running?**

   ```bash
   aws ecs describe-services --cluster pharmax-prod-ue1 \
     --services pharmax-prod-ue1-print-agent \
     --query 'services[0].{desired:desiredCount,running:runningCount,events:events[:5]}'
   ```

   `desired: 0` means someone scaled it down — find out who/why before
   anything else.

2. **Read the stopped task:**

   ```bash
   aws ecs list-tasks --cluster pharmax-prod-ue1 \
     --service-name pharmax-prod-ue1-print-agent --desired-status STOPPED --max-items 3
   aws ecs describe-tasks --cluster pharmax-prod-ue1 --tasks <task-arn> \
     --query 'tasks[0].stoppedReason'
   ```

3. **Boot-time requirements:** the agent resolves a specific workstation
   from the database at boot and needs a network path to a physical Zebra
   printer; without **both** it crash-loops. Logs:

   ```bash
   aws logs start-query --log-group-name /ecs/pharmax-prod-ue1/print-agent \
     --start-time $(($(date +%s) - 1800)) --end-time $(date +%s) \
     --query-string 'fields @timestamp, @message | sort @timestamp desc | limit 50'
   ```

4. **What is queued behind it?** Grafana _Pharmax · Workflow Overview_ →
   **“Queue depth by stage”** (FILL stage growing) and
   **“SLA breaches per minute (by stage)”**.

## Likely causes (ranked)

1. **Crash-loop on boot** — workstation record missing/misconfigured, or
   no network path to the Zebra printer (site VPN / firewall change).
2. **A bad print-agent release** — circuit breaker rolled it back; check
   the running image tag vs. what was dispatched.
3. **Deliberate scale-down that outlived its reason** — remember the ECS
   service ignores `desired_count` drift, so a console scale-down persists
   silently.
4. **Printer-side failure mistaken for agent failure** — the agent runs but
   jobs fail; that is a different signal (print-job failures in logs), not
   this alarm.

## Mitigations

- **Restart:** `aws ecs update-service --cluster pharmax-prod-ue1
--service pharmax-prod-ue1-print-agent --force-new-deployment` — safe.
- **Reprints of anything that was mid-print go through the command path**,
  never by hand:
  [RUNBOOK § Resending a failed print job](../../RUNBOOK.md#resending-a-failed-print-job).
  A reprint outside the command path is an unaudited label — that is a
  workflow-safety violation, not a shortcut.
- **Scaling it back up is a two-part change** (human decision): raise
  `ecs_print_agent_desired_count` in the env-region tfvars in the SAME
  change as any `aws ecs update-service` scaling — otherwise the agent runs
  **unwatched** (this alarm is only created by the tfvars flag).

## Escalation

- Ticket during the night.
- **SEV2 during pharmacy hours** — the floor cannot dispense. Escalate per
  the [alerting runbook](../alerting.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) — check
  `StateReason`.
- If this alarm exists while the site intends the agent to be at 0, the
  tfvars flag and reality have drifted — fix the flag, do not silence the
  alarm. With `treat_missing_data = breaching`, a 0-desired service makes
  the alarm fire permanently, and a permanently-firing alarm teaches the
  rotation to filter the whole feed.
