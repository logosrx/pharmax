# `<prefix>-outbox-stalled`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.

## What fired and what it means

- **Metric:** `OutboxOldestUndispatchedAgeSeconds` (custom namespace
  `Pharmax/Worker`), Maximum — same probe metric as the warning-tier age
  alarm, at the cliff threshold.
- **Threshold:** > 3600 s / 1 hour (`outbox_stalled_threshold_seconds`),
  **3 × 5-minute periods**. Missing data does **not** breach here — a dead
  worker already pages via running-count, and a broken probe raises the
  warning-tier age alarm; double-paging one cause helps nobody.
- **User-visible symptom:** the asynchronous half of the platform is down
  while the console looks fine. An hour outlives any legitimate single
  retry wait (the longest is 64 minutes **cumulatively across attempts**,
  with the longest single wait at 64 min only for a row about to die), so a
  sustained hour-old row means the drainer has stopped making progress
  while commands keep committing: shipping releases, billing
  materialization, notifications, and partner webhook fan-out are all
  silently queued.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`outbox_stalled`).

## Severity + who is paged

**Critical** → `pharmax-prod-ue1-alerts-critical` SNS topic → paging
provider + on-call mailbox. Finding the wedged row/handler is
time-sensitive even at 03:00 — the queue damage accrues every minute.

## First 5 minutes

1. **Is the worker running at all?** If
   [`ecs-worker-running-low`](ecs-running-low.md) is also firing, that is
   the cause — fix that one first.

   ```bash
   aws ecs describe-services --cluster pharmax-prod-ue1 \
     --services pharmax-prod-ue1-worker \
     --query 'services[0].{desired:desiredCount,running:runningCount,events:events[:5]}'
   ```

2. **Is the drainer ticking?** The drainer logs per-tick outcomes:

   ```bash
   aws logs start-query --log-group-name /ecs/pharmax-prod-ue1/worker \
     --start-time $(($(date +%s) - 3600)) --end-time $(date +%s) \
     --query-string 'fields @timestamp, @message | filter @message like /outbox/ | sort @timestamp desc | limit 50'
   ```

   Ticks claiming 0 rows while the backlog is non-zero = every eligible row
   is mid-lease or waiting out backoff; ticks absent entirely = the drain
   loop died inside a live process.

3. **Read the head of the queue:**

   ```sql
   SELECT id, "eventType", status, attempts, "lastError",
          now() - "createdAt" AS age, "nextAttemptAt"
   FROM event_outbox
   WHERE status IN ('PENDING', 'FAILED')
   ORDER BY "createdAt"
   LIMIT 20;
   ```

   One poison row or one wedged downstream is the usual answer.

4. **Depth vs. age:** CloudWatch `pharmax-prod-ue1-overview` → “Event
   outbox backlog (custom)”. **Depth falling with age high = the drainer is
   alive and chewing through a backlog — watch it, don't restart it.**
   Depth flat/rising with age high = a genuine stall.
5. **Which side effects are visibly late:** Grafana _Pharmax · Shipping &
   Tracking_ → “Tracking events recorded (per second, by carrier)” and
   _Pharmax · Billing_ → “Invoice lines per minute” — both flatline during
   a real stall.

## Likely causes (ranked)

1. **A wedged handler holding its lease** — a downstream call with no
   effective timeout. The probe counts leased rows on purpose; the drainer
   cannot re-claim until the lease expires.
2. **A poison row** — a handler that throws deterministically on one
   payload; `attempts` climbs to 8 and the row dies, but a steady supply of
   poison keeps the head of the queue old.
3. **Worker down or crash-looping** — covered by running-count, but the
   stall alarm is the one that captures the accrued damage.
4. **Lock pile-up in Postgres** — claims are `FOR UPDATE SKIP LOCKED`-style
   atomic claims; a long transaction elsewhere holding the table hostage
   shows as claims returning 0. Check `pg_stat_activity` for old
   transactions.
5. **Drain loop dead inside a live process** — the poll loop crashed while
   the container stays healthy; restart is the fix, and a ticket to find
   the crash.

## Mitigations

- **Restart the worker** — the primary 03:00 lever, safe by design:
  completion writes are fenced on the claim's `attempts` token, so a
  handler outliving its lease cannot overwrite a re-claimed row.

  ```bash
  aws ecs update-service --cluster pharmax-prod-ue1 \
    --service pharmax-prod-ue1-worker --force-new-deployment
  ```

- **Do NOT delete or hand-edit outbox rows.** A poison row's disposition
  (fix the handler, then replay) goes through
  [RUNBOOK § Outbox drain stuck or backed up](../../RUNBOOK.md#outbox-drain-stuck-or-backed-up).
- If the wedge is one downstream, waking whoever owns that integration is a
  legitimate 03:00 action — the alternative is an hour more of queued
  shipping/billing.
- After recovery, expect [outbox-dead-rows](outbox-dead-rows.md) to fire
  for anything that exhausted its ladder during the stall — those need the
  admin replay, not dismissal.

## Escalation

Treat as an **availability incident for everything asynchronous** — declare
per [incident response](../../INCIDENT_RESPONSE.md). If it fired outside a
deploy window, wake the owner of the failing handler's downstream. Paging
mechanics: the [alerting runbook](../alerting.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) — check
  `StateReason`.
- **A deliberate bulk backfill** that enqueued hours of work: age is high
  because old rows exist, but depth is falling — the drainer is alive.
  Watch, don't restart.
- A single row on its final 64-minute backoff wait can nudge past an hour
  without a stall; the 3-period requirement filters most of these, and the
  row will either die (→ DEAD alarm) or clear on its own.
