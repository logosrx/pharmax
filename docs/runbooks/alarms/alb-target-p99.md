# `<prefix>-alb-target-p99`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.
> Substitute `pharmax-prod-uw2` in the DR region.

## What fired and what it means

- **Metric:** `TargetResponseTime` p99 (`AWS/ApplicationELB`, dimensions
  `LoadBalancer` + web `TargetGroup`).
- **Threshold:** > 2 s (`alb_target_response_time_p99_seconds`),
  **3 × 5-minute periods** (15 minutes sustained). Missing data does not
  breach.
- **User-visible symptom:** one request in a hundred is slow — the pharmacy
  console feels sluggish on some actions (a save that hangs, a queue that
  takes seconds to load). The workflow still completes; nothing is lost.

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`alb_target_response_p99`).

## Severity + who is paged

**Warning** → `pharmax-prod-ue1-alerts-warning` SNS topic → ticket queue /
shift mailbox. Read at shift start; nobody is paged.

## First 5 minutes

1. **Is it one route or everything?** Grafana _Pharmax · Platform Health_ →
   **“Latency p50 / p95 / p99 (by service)”**. p99 up with p50 flat = a few
   slow requests; p50 rising too = systemic slowdown.
2. **Is it the database?** Same dashboard, **“Postgres pool utilization”** —
   a saturated pool queues every request behind it. Also check
   **“Event-loop p99 lag (seconds)”**: event-loop lag means the Node process
   itself is starved (CPU or a synchronous hot path), not the DB.
3. **Which command is slow?** _Pharmax · Command Bus_ →
   **“Command duration p95 / p99 (seconds)”** — a single command name
   dominating points at one handler / query.
4. Find the slow requests in the web logs:

   ```bash
   aws logs start-query --log-group-name /ecs/pharmax-prod-ue1/web \
     --start-time $(($(date +%s) - 1800)) --end-time $(date +%s) \
     --query-string 'fields @timestamp, @message | filter @message like /durationMs/ | sort @timestamp desc | limit 50'
   ```

5. Trace one slow request end to end —
   [`docs/OBSERVABILITY.md`](../../OBSERVABILITY.md) § tracing. In practice
   the answer is usually one query without an index or one third-party call
   without a tight timeout.

## Likely causes (ranked)

1. **A query regression from the last release** — one statement missing an
   index; confirm in RDS Performance Insights → top SQL by load.
2. **A third-party call without a tight timeout** (Stripe, EasyPost, Clerk)
   on a synchronous path.
3. **Reporting or export traffic on the write path** — a report that should
   read the replica (`REPORTING_DATABASE_URL`) hitting the writer.
4. **CPU saturation on web tasks** — check whether `ecs-web-cpu-high` is
   also firing and whether autoscaling responded (`desiredCount` risen,
   min 3 / max 20).

## Mitigations

- Usually **none at 03:00** — this alarm is a ticket for a reason. File it
  with the offending route/command named.
- If a runaway query is actively degrading the writer: identify it via
  Performance Insights, then a human decision to
  `SELECT pg_terminate_backend(<pid>)` on the reporting session.
- If autoscaling is pinned at max (20) under genuine load, raising
  `ecs_web_max_count` is a Terraform change through the reviewer-gated
  apply — a ticket, not a lever.

## Escalation

Escalate only if p99 keeps climbing or **5xx starts rising with it** — that
combination means timeouts are turning into failures, and
[`alb-5xx-rate`](alb-5xx-rate.md) is about to take over. Declare per the
[alerting runbook](../alerting.md) / [incident response](../../INCIDENT_RESPONSE.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`, see
  [alerting runbook § Proving the pipe works](../alerting.md#proving-the-pipe-works))
  may target a warning-tier alarm to test this topic's path — check
  `StateReason`.
- A report export, bulk import, or scanner generating a small number of
  intentionally slow requests skews p99 at low traffic. Check whether the
  slow requests share one route before treating it as systemic.
