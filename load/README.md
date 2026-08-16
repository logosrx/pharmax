# Pharmax load-test suite (k6)

k6 scripts that put the workloads defined in
[`docs/observability/slos.md`](../docs/observability/slos.md) onto a **staging** environment and
pass/fail against the SLO targets. Plain JavaScript, no npm dependencies — k6 ships its own
runtime and resolves the relative imports in `lib/` itself.

> ## ⚠️ STAGING ONLY — never production
>
> These scripts write real rows (prescriptions, command_log, audit_log, event_outbox) into
> whatever tenant the API key belongs to, and at 10x they are designed to hurt. Every script
> hard-aborts unless **both** of these hold:
>
> 1. `PHARMAX_BASE_URL` does not match a production hostname pattern, **and**
> 2. `PHARMAX_LOAD_ACK=staging-only` is explicitly set.
>
> There is no override for the production-hostname check, on purpose. Do not add one.
> Use a dedicated synthetic staging tenant; never a tenant that shares anything with production.

## Install k6

```bash
# macOS
brew install k6

# Linux (Debian/Ubuntu)
sudo gpg -k && sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Or grab a binary release: https://github.com/grafana/k6/releases
```

## Environment variables

| Variable                    | Required by           | Value                                                                                                                       |
| --------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PHARMAX_BASE_URL`          | all                   | Staging origin, e.g. `https://staging.pharmax.internal.example`                                                             |
| `PHARMAX_LOAD_ACK`          | all                   | Must be the literal string `staging-only`                                                                                   |
| `WORKLOAD`                  | all (optional)        | `smoke` (default), `pilot_1x`, `pilot_5x`, `pilot_10x`                                                                      |
| `PHARMAX_PARTNER_API_KEY`   | intake, mixed         | A staging partner API key (`pxk_...`) with `prescriptions.create` + `orders.read` scopes and a quota tier sized for the run |
| `PHARMAX_SEED_CLINIC_ID`    | intake, mixed         | UUID of a clinic in the staging synthetic seed                                                                              |
| `PHARMAX_SEED_PATIENT_ID`   | intake, mixed         | UUID of an **ACTIVE** synthetic patient **belonging to that clinic**                                                        |
| `PHARMAX_SEED_PROVIDER_ID`  | intake, mixed         | UUID of an **ACTIVE** synthetic provider in the same org                                                                    |
| `PHARMAX_OPS_SESSION_TOKEN` | operator-reads, mixed | `pharmax_session` cookie value for a synthetic load-test operator                                                           |

Notes:

- The seed IDs must satisfy `CreatePrescription`'s existence/ownership checks
  (`packages/orders/src/commands/create-prescription.ts`): unknown patient, inactive patient, or
  patient/clinic mismatch turn every iteration into a 4xx and fail the run's checks — which is
  the desired behavior, loudly.
- Payloads use an uncatalogued synthetic NDC (`99999xxxxxx`) with an explicit
  `NON_CONTROLLED` schedule, so no DEA gates apply and no product-catalog rows are needed.
  Drug name and sig are loudly fake. **Synthetic data only — never PHI** (see
  `.cursor/rules/02-security-compliance.mdc`).
- Operator sessions idle out after 30 minutes and cap at 12 hours
  (`packages/auth/src/configure.ts`); mint the session right before a run.

## Running

Every script defaults to `WORKLOAD=smoke` — 1 VU, 1 iteration — so a bare `k6 run` is always a
safe wiring check, never an accidental load test. Rate workloads run a 10-minute steady state.

```bash
export PHARMAX_BASE_URL=https://staging.pharmax.internal.example
export PHARMAX_LOAD_ACK=staging-only
export PHARMAX_PARTNER_API_KEY=pxk_...        # staging key only
export PHARMAX_SEED_CLINIC_ID=...
export PHARMAX_SEED_PATIENT_ID=...
export PHARMAX_SEED_PROVIDER_ID=...
export PHARMAX_OPS_SESSION_TOKEN=...

# Smoke (wiring/syntax) — one iteration each
k6 run load/scenarios/partner-api-intake.js
k6 run load/scenarios/operator-reads.js
k6 run load/scenarios/mixed-pilot.js

# Pilot volume (1x), then scale
k6 run -e WORKLOAD=pilot_1x  load/scenarios/partner-api-intake.js
k6 run -e WORKLOAD=pilot_5x  load/scenarios/mixed-pilot.js
k6 run -e WORKLOAD=pilot_10x load/scenarios/mixed-pilot.js
```

## Scenarios

| Script                  | Models                                                                  | Executor model                                 |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| `partner-api-intake.js` | Partner EHR prescription submissions (`POST /api/v1/prescriptions`)     | Open (constant-arrival-rate)                   |
| `operator-reads.js`     | Operators cycling the queue views (`/ops/...`) with ~15 s think time    | Closed (constant-vus)                          |
| `mixed-pilot.js`        | Both of the above **plus** partner order polling (`GET /api/v1/orders`) | Composite: two open classes + one closed class |

## Workload model and assumptions

There is no ratified NFR document yet (GO_LIVE D2 is open), so the baseline is an assumption,
stated here and in `docs/observability/slos.md`, and centralized in `lib/config.js`
(`PILOT_BASELINE`):

- **1x pilot** = one site, ~200 prescriptions/day over a 10-hour window; peak-hour factor ~2.5
  and EHR burst factor ~2 give a design peak of **3 submissions/minute**.
- **3 partner order polls/minute** (≈3 integrated EHRs syncing every minute).
- **10 concurrent operators**, ~4 queue reads/minute each.
- **5x / 10x** scale rates and operator population linearly (50 / 100 operators).

Sample-size caveat: at 1x the intake class produces only ~30 requests per 10-minute run, so its
p99 is statistically thin — read p95 at 1x, and trust p99 from the 5x/10x runs. When D2 lands
real NFRs, update `PILOT_BASELINE` and the SLO doc in the same PR.

## How thresholds map to the SLOs

Thresholds are defined once in `lib/config.js` (`SLO`, `sloThresholds`) and applied per traffic
class via the `endpoint` tag. A run **fails (non-zero exit) if any threshold is crossed** — that
is the pass/fail bar.

| Traffic class (tag) | SLO                                         | Thresholds                                            |
| ------------------- | ------------------------------------------- | ----------------------------------------------------- |
| `partner_intake`    | SLO-1 partner prescription submission       | `p(95)<500`, `p(99)<1000` ms; server-error rate <0.1% |
| `partner_poll`      | SLO-1 companion read (`GET /api/v1/orders`) | `p(95)<400`, `p(99)<800` ms; server-error rate <0.1%  |
| `operator_read`     | SLO-4 queue view / dashboard read path      | `p(95)<800`, `p(99)<1500` ms; server-error rate <0.1% |
| all                 | correctness bar                             | `checks` rate >99% per class                          |

Availability SLIs count **5xx only** (dedicated `*_server_errors` Rate metrics): 429s are
quota shaping by design (ADR-0032) and are counted separately
(`partner_intake_rate_limited`) — if they appear at 10x, raise the staging key's quota tier
rather than reading them as an SLO breach.

## Reading results

k6 prints a summary at the end; the lines that matter:

- `http_req_duration{endpoint:...}` — compare `p(95)`/`p(99)` to the table above. k6 marks each
  crossed threshold with a ✗ and exits non-zero.
- `*_server_errors` — the availability SLI per class. Anything above 0.1% is an SLO breach.
- `checks{endpoint:...}` — correctness (expected statuses, response shapes). Failures here with
  4xx statuses usually mean wrong seed IDs or an expired operator session, not a platform
  problem.
- `partner_intake_idempotent_replays` — should be ~0 (every iteration generates a fresh
  `Idempotency-Key`); a non-zero count means key generation collided or a retry happened.
- `dropped_iterations` in a rate scenario means the load generator itself could not keep up —
  raise `maxVUs` in `lib/config.js` before blaming the platform.

While a run is live, watch the **server side** in the staging dashboards — the k6 numbers only
see the HTTP edge:

- `pharmax_command_duration_seconds{command_name="CreatePrescription"}` and
  `pharmax_command_dispatched_total{outcome}` (command bus).
- `pharmax_outbox_claim_lag_seconds` and CloudWatch `OutboxOldestUndispatchedAgeSeconds` /
  `OutboxUndispatchedDepth` (`Pharmax/Worker` namespace) — every accepted intake enqueues a
  `prescription.created.v1` outbox row, so intake runs double as SLO-3 drain tests.
- Aurora CPU/connections and the pg-pool saturation alert (`PgPoolSaturated`) — the expected
  first bottleneck at 10x.

## What this suite deliberately does not cover

- **Operator command dispatch under load (SLO-2)** — needs seeded orders in valid workflow
  states and per-VU operator sessions; that belongs to the GO_LIVE D2 harness built on the E2E
  seed (D1). The command-bus write path is still exercised via intake.
- **SSE live-counts feed** (`/api/ops/queue/stream`) — k6's HTTP client does not consume event
  streams; time-to-first-event needs a browser-based check (documented gap in SLO-4).
- **Print pipeline (SLO-5)** — requires a live site and a fake print agent; the SLO exists so
  instrumentation lands with the first site.
- **24-hour soak** — run `mixed-pilot.js` with a longer `STEADY_STATE_DURATION` once a dedicated
  staging window exists; not the default so nobody parks 10x on shared staging by accident.
