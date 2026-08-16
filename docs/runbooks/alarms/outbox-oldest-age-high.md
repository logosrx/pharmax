# `<prefix>-outbox-oldest-age-high`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.

## What fired and what it means

- **Metric:** `OutboxOldestUndispatchedAgeSeconds` (custom namespace
  `Pharmax/Worker`), Maximum — age of the oldest `event_outbox` row in
  PENDING or FAILED. Published every ~60 s by the worker's
  outbox-backlog-probe loop
  (`apps/worker/src/metrics/outbox-backlog-probe.ts`).
- **Threshold:** > 900 s / 15 min
  (`outbox_oldest_age_warning_threshold_seconds`), **3 × 5-minute
  periods**. **Missing data breaches** — deliberately: a probe that stops
  publishing is either a dead worker (already paging via running-count) or
  a broken probe, and "monitoring configured but disconnected" is this
  repository's signature failure.
- **User-visible symptom:** some side effect is at least 15 minutes late —
  a shipping notification not sent, a billing line not materialized, a
  partner webhook not delivered, a label not dispatched. The console looks
  normal.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`outbox_oldest_age_high`).

## Severity + who is paged

**Warning** → `pharmax-prod-ue1-alerts-warning` SNS topic → ticket queue /
shift mailbox. The cliff (a stalled drainer) has its own **critical** alarm
at one hour: [outbox-stalled](outbox-stalled.md).

## First 5 minutes

1. **Rule out the probe being the problem.** This alarm fires on MISSING
   data on purpose:

   ```bash
   aws logs start-query --log-group-name /ecs/pharmax-prod-ue1/worker \
     --start-time $(($(date +%s) - 1800)) --end-time $(date +%s) \
     --query-string 'fields @timestamp, @message | filter @message like /outbox.backlog.probe/ | sort @timestamp desc | limit 20'
   ```

   `outbox.backlog.probe.failed` lines = the probe is broken, not the
   backlog. No lines at all + worker running = the probe loop died.

2. **Read the oldest rows** (system credentials, read-only):

   ```sql
   SELECT id, "eventType", status, attempts, "lastError",
          now() - "createdAt" AS age, "nextAttemptAt"
   FROM event_outbox
   WHERE status IN ('PENDING', 'FAILED')
   ORDER BY "createdAt"
   LIMIT 20;
   ```

3. **One event type or many?** One type failing repeatedly = a downstream
   or handler bug riding the retry ladder. Many types aging together =
   early drainer trouble — treat as [outbox-stalled](outbox-stalled.md)
   arriving early.
4. **Dashboards:** CloudWatch `pharmax-prod-ue1-overview` → “Event outbox
   backlog (custom)” (age + depth + DEAD together); Grafana _Pharmax ·
   Shipping & Tracking_ → **“Carrier poll failure ratio (rolling 15m)”**
   and _Pharmax · Billing_ → **“Stripe push success ratio (15m)”** to spot
   which downstream is refusing.

## Likely causes (ranked)

The drainer (`apps/worker/src/drains/event-outbox-drainer.ts`) claims and
leases rows in batches, routes each to a registered handler, and retries
failures on an exponential ladder: 30 s, 1 m, 2 m, 4 m … 64 m, 8 attempts,
then DEAD. Given that:

1. **One failing handler riding its backoff ladder** — a single event type
   with climbing `attempts` and a meaningful `lastError` (a downstream —
   Resend, a partner webhook endpoint, Stripe — refusing). Cumulative
   backoff passes ~16 min around attempt 6, which is exactly when this
   alarm fires.
2. **A row with NO registered handler** — deliberately a _failure_, never a
   silent success (marking it DISPATCHED would discard the event with no
   replay). `lastError` names the missing handler; the fix is a code
   change.
3. **The webhook fan-out post-handler hook failing** — it runs inside the
   same try as the domain handler, so a fan-out throw routes the row
   through FAILED/backoff exactly like a handler throw.
4. **A handler holding its lease forever** — the probe measures age over
   PENDING+FAILED regardless of lease state on purpose; a wedged handler
   shows here first.
5. **The probe itself broke** (missing-data path) — worker up, no
   datapoints, `outbox.backlog.probe.failed` in the logs.

## Mitigations

- **Nothing to restart yet** if it is one event type riding backoff — the
  ladder is doing its job. Ticket with `eventType` + `lastError` attached.
- If the downstream is in a known outage: wait it out; rows retry
  automatically. Confirm depth is not exploding (same probe, `OutboxUndispatchedDepth`).
- **Restart the worker** only if many types are aging together (a human
  decision — it interrupts in-flight leases; completion writes are fenced
  on the claim's `attempts` token, so a re-claimed row cannot be
  double-completed):

  ```bash
  aws ecs update-service --cluster pharmax-prod-ue1 \
    --service pharmax-prod-ue1-worker --force-new-deployment
  ```

- Full procedure:
  [RUNBOOK § Outbox drain stuck or backed up](../../RUNBOOK.md#outbox-drain-stuck-or-backed-up).

## Escalation

Ticket. Escalate if age keeps climbing toward the 1-hour critical
threshold, or the affected event type carries shipping or billing.
Declaration mechanics: the [alerting runbook](../alerting.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) — check
  `StateReason`.
- **Missing-data firings during a deploy:** three empty 5-minute periods
  absorb a normal deploy gap, so a firing here means the worker (or probe)
  was quiet for 15+ minutes — that is real even when the backlog is not.
- A known downstream outage with rows riding backoff as designed is
  working-as-intended; the alarm is still correct to point at it.
