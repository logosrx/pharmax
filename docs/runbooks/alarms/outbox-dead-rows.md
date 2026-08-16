# `<prefix>-outbox-dead-rows`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.

## What fired and what it means

- **Metric:** `OutboxDeadDepth` (custom namespace `Pharmax/Worker`),
  Maximum — count of `event_outbox` rows in status DEAD. Published every
  ~60 s by the worker's outbox-backlog probe.
- **Threshold:** > 0, **1 × 5-minute period** — any DEAD row fires. Missing
  data does not breach. **The alarm holds ALARM state until the rows are
  dealt with** — deliberate: the mailbox owner should keep seeing it until
  someone acts.
- **User-visible symptom:** a load-bearing side effect has been
  **permanently missed** — a shipping notification never sent, a billing
  line never materialized, a partner webhook never delivered. The drainer
  exhausted all 8 attempts (~2 h of ladder) and will **never** retry a DEAD
  row on its own. It stays wrong until an admin replays it, but it is not
  getting _more_ wrong by the minute.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`outbox_dead_rows`).

## Severity + who is paged

**Warning** → `pharmax-prod-ue1-alerts-warning` SNS topic → ticket queue /
shift mailbox. The honest 03:00 response is "read the lastError, replay in
the morning" — so it does not page.

## First 5 minutes

1. **Read the DEAD rows:**

   ```sql
   SELECT id, "eventType", attempts, "lastError",
          "createdAt", "updatedAt"
   FROM event_outbox
   WHERE status = 'DEAD'
   ORDER BY "createdAt";
   ```

   `lastError` names the handler failure. `eventType` tells you the blast
   radius: a shipping/billing type has an operational cleanup on the other
   side, a digest email does not.

2. **How did they die?** Cross-reference the drainer's log for the final
   attempts:

   ```bash
   aws logs start-query --log-group-name /ecs/pharmax-prod-ue1/worker \
     --start-time $(($(date +%s) - 86400)) --end-time $(date +%s) \
     --query-string 'fields @timestamp, @message | filter @message like /dead/ | sort @timestamp desc | limit 30'
   ```

3. **Was this a stall's aftermath?** Check whether
   [outbox-stalled](outbox-stalled.md) fired in the last ~24 h — rows that
   exhausted their ladder during a stall die in a batch when it clears.
4. Dashboards: CloudWatch `pharmax-prod-ue1-overview` → “Event outbox
   backlog (custom)” (`OutboxDeadDepth` series); Grafana _Pharmax ·
   Billing_ → “Recent Stripe push failures (Loki)” if the dead type is
   billing-bearing.

## Likely causes (ranked)

1. **A deterministic handler bug for one payload** (poison event) — the
   same `lastError` on every attempt.
2. **A downstream outage that outlasted the ~2-hour retry ladder** —
   `lastError` shows the downstream refusing; the batch of deaths clusters
   at the outage window.
3. **An event type with no registered handler** — the drainer deliberately
   fails these (never a silent success, because marking DISPATCHED would
   discard the event with no replay path); if nobody noticed for 8
   attempts, the row dies. The fix is a code change registering the
   handler, then replay.
4. **A webhook fan-out target permanently rejecting** (dead partner
   endpoint, rotated secret) — the post-handler hook failure rides the same
   ladder.

## Mitigations

- **Fix the cause first, then replay.** The row is re-published through the
  admin replay path —
  [RUNBOOK § Outbox drain stuck or backed up](../../RUNBOOK.md#outbox-drain-stuck-or-backed-up).
- **Never mark a DEAD row DISPATCHED by hand.** That erases the missed work
  without performing it — the notification stays unsent, the invoice line
  stays missing, and now nothing will ever say so.
- Replay is a human decision per row type: replaying a stale shipping
  notification hours later may be worse than suppressing it and handling
  the customer impact manually — decide per event type, note the decision
  in the ticket.

## Escalation

Ticket, **same morning** — the longer a DEAD shipping or billing event
sits, the harder the cleanup on the other side. Escalate to an incident
only if the dead rows reveal an ongoing failure (in which case another
alarm is usually already firing). Mechanics: the
[alerting runbook](../alerting.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) — check
  `StateReason`, then confirm with the SQL above that no DEAD rows actually
  exist.
- **Already-known rows:** yesterday's incident with replay scheduled keeps
  the alarm in ALARM until the replay happens. That is the design working,
  not noise — but it is never _noise_: a DEAD row is work the platform
  promised and did not do.
