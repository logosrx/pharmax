# Pharmax Service Level Objectives

Status: Proposed (first formal SLO set)
Owner: Platform team
Companion artifacts: `load/` (k6 suite whose thresholds encode these SLOs),
`observability/prometheus/rules/slo-rules.yaml` (recording rules),
`observability/prometheus/rules/alert-rules.yaml` (symptom alerts),
`infra/terraform/modules/cloudwatch/main.tf` (CloudWatch alarms).

## Why this document exists

The platform already alerts well on **symptoms** — 14+ CloudWatch alarms (Aurora CPU/memory/
connections/replica lag, ECS task health, ALB 5xx and p99, audit-chain integrity, outbox
backlog) plus a Prometheus rule set covering the command bus, KMS, shipping, and billing. None
of those state the **outcome** the platform promises: "a partner's prescription submission
succeeds within X ms", "a committed order's side effects run within N seconds". This document
defines those outcomes as SLOs with explicit SLIs, targets, windows, error budgets, and the
burn-rate alerting policy that should eventually replace static-threshold paging for
user-facing paths.

Targets below are **implementable, not aspirational**: they are anchored to thresholds already
encoded in the alerting stack (e.g. `HighP99HttpLatency` fires at 1.5 s; the outbox claim-lag
histogram has explicit bucket edges at 10 s and 60 s) so the first SLO iteration can be measured
with instruments that exist today. Gaps are called out per SLO.

## Conventions

- **Window:** 28-day rolling, aligned with the Google SRE workbook convention. Fast/slow burn
  alerting windows are listed per SLO.
- **Availability SLI:** `good requests / total requests` where "good" excludes 5xx responses.
  4xx responses are the caller's problem and count as good (except where noted); 429s from the
  partner-API quota tiers are deliberate shaping (ADR-0032) and count as good.
- **Latency SLI:** ratio of requests faster than the stated threshold, measured server-side from
  `http_server_request_duration_seconds` (OTel semconv histogram; see
  `observability/prometheus/rules/slo-rules.yaml`, which already records
  `pharmax:http_p99_duration_seconds:5m` and friends) or from the domain histograms named per
  SLO.
- **Error budget:** `1 - target` over the window. At 99.9% over 28 days the budget is
  ~40 minutes of full unavailability or the equivalent partial degradation.
- **Burn rate:** budget consumption speed. Burn rate 1 = exactly exhausting the budget at window
  end. The recommended multiwindow policy (per SLO below) is the standard 4-tier ladder:

  | Tier | Burn rate | Long window | Short window | Action        |
  | ---- | --------- | ----------- | ------------ | ------------- |
  | 1    | 14.4x     | 1 h         | 5 m          | Page          |
  | 2    | 6x        | 6 h         | 30 m         | Page          |
  | 3    | 3x        | 24 h        | 2 h          | Ticket        |
  | 4    | 1x        | 3 d         | 6 h          | Ticket/review |

  Both windows must breach before the alert fires (the short window suppresses stale alerts once
  the incident ends). These do not exist today anywhere in the stack — every current alert is a
  static threshold — and are the single biggest recommended addition.

## Assumed pilot baseline

There is no quantified NFR document yet (`docs/GO_LIVE_PROGRAM.md` D2 lists "documented NFRs
(orders/day, concurrent operators, queue-read p95)" as an open deliverable; the G3 gate holds at
10 orders/day for the first week). Until D2 lands real numbers, this document and the k6 suite
assume:

- **Pilot (1x):** one pharmacy site, **200 prescriptions/day** arriving over a 10-hour intake
  window, peak-hour factor ~2.5 and EHR batch-burst factor ~2 → **design peak ≈ 180 intake
  requests/hour (3/minute)** sustained.
- **10 concurrent operators** at pilot, each generating ~4 queue/dashboard reads per minute.
- **5x and 10x** scale those arrival rates and the operator population linearly (50 and 100
  concurrent operators respectively).

If the D2 NFR work produces different numbers, update this section and
`load/lib/config.js` (single source of the workload model) together.

---

## SLO-1 — Partner API prescription submission

**The flagship intake path.** ADR-0040 made `POST /api/v1/prescriptions`
(`apps/web/app/api/v1/prescriptions/route.ts`) the sole programmatic eRx surface: partner EHRs
connect directly, authenticate with a `pxk_` API key, supply an `Idempotency-Key`, and the route
dispatches the same `CreatePrescription` command the ops console uses. If this path is slow or
down, prescriptions do not enter the platform.

| Property          | Value                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| **SLI (avail.)**  | non-5xx responses / all responses on `POST /api/v1/prescriptions` (429s count as good — quota shaping by design) |
| **Target**        | 99.9% over 28 d (budget ≈ 40 min)                                                                                |
| **SLI (latency)** | requests completing < 1.0 s / all successful requests, server-side                                               |
| **Target**        | p99 ≤ 1.0 s, p95 ≤ 0.5 s over 28 d                                                                               |

The latency target budgets for what the route actually does: API-key hash resolution, two
rate-limiter round-trips (Redis), the command bus (idempotency check, `command_log` insert,
transaction), 4+ tenancy-scoped reads, an Rx-number allocator row lock, **four KMS
`encryptField` calls** (sig, two notes, indication), a blind-index computation, and audit +
outbox writes in the same transaction. Sub-500 ms p99 is not realistic with per-request KMS in
the loop; 1.0 s is achievable and still comfortably under the 1.5 s `HighP99HttpLatency`
warning.

**Measured today by:**

- `http_server_request_duration_seconds` (OTel semconv) — recorded but only aggregated
  **service-wide** (`pharmax:http_p99_duration_seconds:5m` groups by `service_name`, not
  `http_route`).
- `pharmax_command_duration_seconds{command_name="CreatePrescription"}` and
  `pharmax_command_dispatched_total{outcome}` from `packages/command-bus/src/execute-command.ts`
  — the closest per-path signal that exists.
- CloudWatch `<prefix>-alb-5xx-rate` (critical, >1%) and `<prefix>-alb-target-p99` (warning,
  > 2 s) — both ALB-wide, mixing this route with static assets and console page loads.

**Missing:**

- A per-route (`http_route="/api/v1/prescriptions"`) recording rule for availability and
  latency quantiles. The raw histogram carries the label; only the rules aggregate it away.
- Burn-rate alerts. Recommended policy: the standard 4-tier ladder above on the availability
  SLI, and tiers 1–2 only (page-only) on the latency SLI to avoid ticket noise while volume is
  low.
- A partner-visible status/SLA page once external EHRs integrate (out of scope here).

**k6 coverage:** `load/scenarios/partner-api-intake.js` — thresholds `p(95)<500`, `p(99)<1000`,
server-error rate < 0.1%.

---

## SLO-2 — Operator command dispatch

Every workflow mutation an operator performs — start/complete typing, PV1 approve/reject, fill,
final verification, release-to-ship, print, cancel — is a `POST` to
`apps/web/app/api/ops/orders/[orderId]/<command>/route.ts`, which dispatches through the command
bus (validation → idempotency → row lock → domain write → `command_log` + `order_event` +
`audit_log` + `event_outbox` in one transaction). A slow dispatch is a pharmacist standing at a
fill bench waiting.

| Property          | Value                                                                |
| ----------------- | -------------------------------------------------------------------- |
| **SLI (avail.)**  | non-5xx responses / all responses on `POST /api/ops/orders/*` routes |
| **Target**        | 99.9% over 28 d                                                      |
| **SLI (latency)** | API-route round-trip < 1.5 s (p99) and < 0.5 s (p95), server-side    |
| **Target**        | p95 ≤ 0.5 s, p99 ≤ 1.5 s over 28 d                                   |

The p99 anchor of 1.5 s deliberately equals the existing `HighP99HttpLatency` alert threshold
in `observability/prometheus/rules/alert-rules.yaml` — the alert becomes the SLO's fast-burn
proxy until burn-rate rules exist.

**Measured today by:**

- `pharmax_command_duration_seconds` (histogram, per `command_name`) and
  `pharmax_command_dispatched_total{outcome=success|fail|refused|replay|sod_rejected}` — this is
  the best current SLI source because it isolates dispatch cost from Next.js overhead.
- Recording rules `pharmax:command_p99_duration_seconds:5m` and
  `pharmax:command_error_ratio:5m` already exist.
- Alerts `CommandBusErrorRateHighWarning` (>1%/10 m) and `CommandBusErrorRateHighCritical`
  (>5%/5 m) — these are burn-rate alerts in spirit; formalizing them against the 99.9% budget
  gives roughly the same thresholds (tier-1 at 14.4x on a 0.1% budget ≈ 1.44% error rate).

**Missing:**

- Route-level availability for the ops API distinct from console page loads (same per-route
  recording-rule gap as SLO-1).
- A latency SLI: `pharmax_command_duration_seconds` exists but no alert or rule consumes its
  quantiles per command. Recommended: tier 1–2 burn-rate alerts on the fraction of dispatches
  slower than 1.5 s.

**k6 coverage:** indirect. Synthesizing operator command load requires seeded orders in valid
workflow states plus an operator session per VU; the k6 suite exercises the same command-bus
write path via partner intake (SLO-1) and measures the read side (SLO-4). Full command-chain
load (`RECEIVED → SHIPPED` under concurrency, row-lock contention on the hot order path) is
GO_LIVE D2 work and needs the seeded E2E harness (D1) first. This is a known limitation, not an
oversight.

---

## SLO-3 — Order pipeline outcome (outbox drain)

Every command's side effects — partner webhook fan-out, billing materialization, label
dispatch, notifications, SLA escalation — ride `event_outbox` rows drained by
`apps/worker/src/drains/event-outbox-drainer.ts`. The console can look healthy while this
pipeline silently stalls; that failure mode is why the outbox has its own CloudWatch alarms.

| Property          | Value                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| **SLI (latency)** | outbox events claimed by the drainer within 10 s of `event_outbox.createdAt` |
| **Target**        | 99% within 10 s, 99.9% within 60 s, over 28 d                                |
| **SLI (outcome)** | events reaching a terminal `success` outcome / all drained events            |
| **Target**        | 99.9% over 28 d (DEAD rows are budget burn until replayed)                   |

The 10 s / 60 s edges are chosen because they are **exact bucket boundaries** of the existing
`pharmax_outbox_claim_lag_seconds` histogram (`[0.5, 1, 5, 10, 30, 60, 300, 900]`), so the SLI
is computable today without re-bucketing.

**Measured today by:**

- `pharmax_outbox_claim_lag_seconds` (histogram) — wall time from row creation to drainer claim.
- `pharmax_outbox_dispatched_total{outcome=success|fail|dead}` and `pharmax_outbox_dead_total`.
- CloudWatch (namespace `Pharmax/Worker`, published ~60 s by the outbox-backlog probe):
  `OutboxOldestUndispatchedAgeSeconds`, `OutboxUndispatchedDepth`, `OutboxDeadDepth`, wired to
  alarms `<prefix>-outbox-oldest-age-high` (warning at 900 s), `<prefix>-outbox-stalled`
  (critical at 3600 s), `<prefix>-outbox-dead-rows` (warning at >0). Prometheus alert
  `OutboxDeadLetters` duplicates the dead-row signal.

**Missing:**

- **End-to-end processing latency.** Claim lag stops at the claim; there is no histogram for
  `createdAt → handler completion`. A handler that claims fast and runs slow is invisible to the
  SLI. Recommended instrument: `pharmax_outbox_process_duration_seconds` (same bucket ladder)
  emitted at terminal outcome in the drainer.
- Burn-rate alerts on the 10 s SLI. The existing 900 s/3600 s oldest-age alarms are cliff
  detectors (good, keep them) but a slow leak — say 5% of events taking 5 minutes — never trips
  them while quietly torching the budget. Tier 2–4 of the ladder on the claim-lag ratio covers
  this; tier 1 is unnecessary because the CloudWatch stall alarm already pages faster on the
  cliff case.

**k6 coverage:** indirect — every successful intake iteration in
`load/scenarios/partner-api-intake.js` enqueues a `prescription.created.v1` outbox row, so an
intake run at 5x/10x is also a drain load test. Verify the claim-lag histogram and
`OutboxOldestUndispatchedAgeSeconds` in the staging dashboards during the run; k6 cannot observe
worker-side completion from the outside.

---

## SLO-4 — Queue view / dashboard read path

Operators live in the queue views (`apps/web/app/ops/{typing,pv1,fill,final,shipping,orders}`),
which are server-rendered against tenancy-scoped Postgres reads, plus the live-counts SSE feed
`GET /api/ops/queue/stream` (`QueueCountsBroadcaster`, ADR-0034: snapshot on subscribe, updates
on change, heartbeat every 20 s, hard reconnect at 5 min).

| Property            | Value                                                                            |
| ------------------- | -------------------------------------------------------------------------------- |
| **SLI (avail.)**    | non-5xx responses / all responses on ops queue pages and `/api/ops/queue/stream` |
| **Target**          | 99.9% over 28 d                                                                  |
| **SLI (latency)**   | server response time of queue-view page loads                                    |
| **Target**          | p95 ≤ 800 ms, p99 ≤ 1.5 s over 28 d                                              |
| **SLI (freshness)** | SSE subscribe → first `counts` event                                             |
| **Target**          | p95 ≤ 2 s over 28 d (proposed; not measurable today)                             |

**Measured today by:**

- `http_server_request_duration_seconds` service-wide quantiles (same per-route gap as SLO-1/2).
- `pharmax_workflow_queue_depth` / `pharmax_workflow_emergency_bucket_size` (worker-side gauges
  from `apps/worker/src/metrics/workflow-bucket-scraper.ts`) tell you what the queues contain
  but nothing about read latency.
- ALB p99 alarm as the blunt backstop.

**Missing:**

- Per-route quantiles for the ops pages (recording-rule change only).
- Any instrumentation of the SSE feed: no connection count, no time-to-first-event, no broadcast
  fan-out latency. Recommended: a `pharmax_queue_stream_first_snapshot_seconds` histogram and an
  active-connections gauge in the broadcaster.
- Burn-rate alerts: tiers 2–4 on the latency SLI (a slow dashboard is a degradation, not a page
  at 03:00 — matching the severity philosophy documented in the CloudWatch module).

**k6 coverage:** `load/scenarios/operator-reads.js` — session-cookie VUs cycling the queue
views with think time; thresholds `p(95)<800`, `p(99)<1500`, error rate < 0.1%. SSE
time-to-first-event is **not** load-tested (k6's HTTP client does not consume event streams);
noted as a follow-up for a browser-based check.

---

## SLO-5 — Print job: submitted → confirmed

`PrintVialLabel` (`POST /api/ops/orders/[orderId]/print-vial-label`) creates a `print_job` row
(`PENDING`), the outbox event `labels.vial_print.requested.v1` reaches
`apps/worker/src/drains/dispatch-vial-print-job.ts` which advances it `PENDING → SENT`, and the
site's print agent (`apps/print-agent`) claims the `SENT` job under a lease and confirms
`COMPLETED` (or `FAILED`, never silently — workflow rule). A vial label that does not print
stops dispensing at the bench.

| Property                                                     | Value                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **SLI (latency)**                                            | `print_job.createdAt → status=COMPLETED` while the owning site is live           |
| **Target**                                                   | 95% within 15 s, 99% within 60 s, over 28 d — **effective only once a site is    |
| live** (prod runs `ecs_print_agent_desired_count = 0` today) |
| **SLI (outcome)**                                            | jobs reaching `COMPLETED` / all non-cancelled jobs                               |
| **Target**                                                   | 99.5% over 28 d (a `FAILED` job with a visible reason is budget burn, not a rule |
| violation)                                                   |

**Measured today by: nothing.** This is the least-instrumented pipeline in the platform:

- `apps/print-agent` emits no OTel metrics at all (Sentry only).
- No histogram covers any `print_job` state transition.
- The only alarm is CloudWatch `<prefix>-ecs-print-agent-running-low` (warning), created only
  when `print_agent_running_alarm_enabled` — liveness of the process, nothing about jobs.

**Missing (all of it):**

- `pharmax_print_job_completion_seconds` histogram (createdAt → COMPLETED, labelled by site)
  emitted by the print agent on confirm, and a `pharmax_print_job_terminal_total{outcome}`
  counter. The worker can emit the `PENDING → SENT` leg separately to localize blame.
- A stuck-job probe (oldest non-terminal `print_job` age, mirroring the outbox probe pattern) —
  the claim-lease design means a crashed agent leaves `SENT` jobs in limbo that nothing watches.
- Burn-rate alerting: tiers 1–2 on the 15 s SLI **during site business hours only** (printing
  is a business-hours function; the CloudWatch module's severity comments already establish
  this philosophy).

**k6 coverage:** none — load-testing print requires seeded orders in `FILL_IN_PROGRESS` plus a
fake print agent, and hammering a real thermal printer from a load tool is not a thing we do.
The SLO is defined now so the instrumentation lands with the first live site.

---

## Adoption order (recommended)

1. **Recording rules** for per-route availability/quantiles on `/api/v1/prescriptions`,
   `/api/ops/orders/*`, and the ops queue pages — pure `slo-rules.yaml` addition, no code.
2. **Burn-rate alert pairs** for SLO-1 and SLO-2 availability (replaces nothing; the static
   alarms stay as backstops).
3. **Outbox process-duration histogram** (SLO-3 gap) — one histogram in the drainer.
4. **SSE + print instrumentation** (SLO-4/5 gaps) — with the first live pharmacy site.
5. Revisit all targets after the first 28-day window with real pilot traffic; tighten or loosen
   with evidence, and encode any change in `load/lib/config.js` thresholds in the same PR.
