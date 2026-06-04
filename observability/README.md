# Pharmax Observability Stack — Dashboards & Alerts as Code

This directory is the **source of truth** for everything an operator looks at when
something goes wrong in Pharmax: the OpenTelemetry collector pipeline, the metric
storage layout, the Grafana dashboards, and the Prometheus alert rules.

> **Scope.** This lands the artifacts. Production wiring — IAM, VPC routing,
> Terraform that mounts these files into a managed stack — is a follow-up task.
> Everything here runs locally via `docker compose` and is consumable by any
> environment that mounts the same files.

---

## Storage stack chosen: Prometheus + Tempo + Loki (self-hosted)

We considered three options. The chosen one is at the top.

| Option                                 | Why we chose / didn't                                                                                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prometheus + Tempo + Loki (chosen)** | 100% open source, BAA-friendly with HIPAA-eligible cloud storage (S3 with SSE-KMS), portable across AWS/GCP/on-prem, no per-host vendor cost. Grafana is the single pane of glass.                                                                  |
| Datadog                                | Easy to operate but BAA covers a subset of features. Per-host pricing makes traces at 100% sampling expensive. Available as a thin alternate exporter — see [`collector/config.yaml`](./collector/config.yaml) commented `datadog/` exporter block. |
| Grafana Cloud                          | Same Grafana UX with managed storage. We don't preclude it — the dashboards in this directory are vendor-neutral and load directly into Grafana Cloud via the same provisioner.                                                                     |

The collector is configured to **fan out** so a single environment can ship to
local Prometheus + Tempo + Loki **and** a vendor (Datadog / Grafana Cloud) at
the same time. See [`collector/README.md`](./collector/README.md).

---

## Directory layout

```
observability/
├── README.md
├── docker-compose.yml          # local dev stack
├── collector/
│   ├── config.yaml             # OTLP/HTTP in → Prom/Tempo/Loki out
│   └── README.md
├── prometheus/
│   ├── prometheus.yml          # scrape config (collector + node-exporter)
│   └── rules/
│       ├── slo-rules.yaml      # recording rules
│       └── alert-rules.yaml    # alerting rules
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/
│   │   │   ├── prometheus.yaml
│   │   │   ├── tempo.yaml
│   │   │   └── loki.yaml
│   │   └── dashboards/
│   │       └── pharmax.yaml
│   └── dashboards/
│       ├── workflow-overview.json
│       ├── command-bus.json
│       ├── audit-chain.json
│       ├── shipping-tracking.json
│       ├── billing.json
│       └── platform-health.json
└── runbooks/
    ├── command-bus-failures.md
    ├── audit-chain-broken.md
    ├── shipping-tracking-stalled.md
    └── kms-misconfig.md
```

---

## Local dev — `make obs-up`

From the repo root:

```bash
docker compose -f observability/docker-compose.yml up -d
```

Or, if a `Makefile` target is added:

```bash
make obs-up   # docker compose ... up -d
make obs-down # docker compose ... down -v
```

What boots:

| Service                               | Port | What it does                                   |
| ------------------------------------- | ---- | ---------------------------------------------- |
| `otel-collector` (`otel/contrib`)     | 4318 | OTLP/HTTP ingest; matches `@pharmax/telemetry` |
| `otel-collector` (Prometheus exposer) | 8889 | Scrape target for Prometheus                   |
| `prometheus`                          | 9090 | Metric storage + alert evaluation              |
| `tempo`                               | 3200 | Trace storage (OTLP write at `collector:4317`) |
| `loki`                                | 3100 | Log storage                                    |
| `grafana`                             | 3001 | Dashboards UI (admin/admin in dev only)        |

Then point the apps at the collector:

```bash
# .env.local
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_VERSION=$(git rev-parse --short HEAD)
```

Grafana is preprovisioned with all three datasources and all six dashboards.
Open http://localhost:3001/dashboards.

---

## Production wiring (out of scope, for reference)

When Terraform lands, the production pipeline is:

```
apps → otel-collector (ECS sidecar or daemonset)
        ├── prometheus-remote-write → AMP (AWS Managed Prometheus) / Grafana Cloud Metrics
        ├── otlphttp → AMP-Tempo / Grafana Cloud Tempo
        └── loki    → Grafana Cloud Logs / self-hosted Loki on S3
```

The dashboards and alert rules in this directory are written to be **portable**:
they reference Prometheus metric names (not vendor metric IDs), so they load
unchanged into AMG (AWS Managed Grafana), Grafana Cloud, or self-hosted
Grafana.

Where secrets go:

- **Collector → vendor** (Datadog API key, Grafana Cloud token): AWS Secrets
  Manager → injected as collector env vars at task definition time. Never in
  this repo. See [`docs/security/secrets-management.md`](../docs/security/secrets-management.md).
- **Collector TLS certs**: per-environment, mounted from Secrets Manager.
- **Grafana admin password**: SSO via the org IdP (Clerk in our case is for
  customers; ops Grafana uses corporate IdP).

---

## Metric naming convention

All Pharmax custom metrics are prefixed `pharmax_<domain>_<unit_or_event>`. Unit
suffixes follow OTel conventions:

| Suffix              | Type      | Example                            |
| ------------------- | --------- | ---------------------------------- |
| `_total`            | Counter   | `pharmax_command_dispatched_total` |
| `_duration_seconds` | Histogram | `pharmax_command_duration_seconds` |
| (none) gauge        | Gauge     | `pharmax_workflow_queue_depth`     |

Standard labels: `service`, `deployment_environment` (from OTel resource), and
domain-specific labels per metric. **No PHI in labels.** `organization_id` is
the opaque tenant UUID — never a tenant name, never a patient identifier. See
[`collector/README.md`](./collector/README.md) for the defensive PHI scrub.

### Currently-emitted metrics (auto-instrumentation only)

The `@pharmax/telemetry` package wires `auto-instrumentations-node` which gives
you HTTP, fetch, undici, Express, Next, pg, mysql, AWS SDK v3, Redis/ioredis
auto-spans and standard semantic-convention HTTP server metrics
(`http_server_request_duration_seconds`, etc.). The dashboards include panels
that work today against those signals.

### Wired custom metrics

The `pharmax_*` series referenced by every dashboard and alert in this directory
emit from the locations below. **Status legend:** ✅ live, 📋 named but not yet
wired (alert evaluates to `0`).

| Metric                                                             | Status | Where it emits from                                                                                                  |
| ------------------------------------------------------------------ | :----: | -------------------------------------------------------------------------------------------------------------------- |
| `pharmax_command_dispatched_total{command_name, outcome}`          |   ✅   | `packages/command-bus/src/execute-command.ts` (success / fail / replay / sod_rejected)                               |
| `pharmax_command_duration_seconds{command_name, outcome}`          |   ✅   | same                                                                                                                 |
| `pharmax_command_idempotency_dedup_total{command_name}`            |   ✅   | same                                                                                                                 |
| `pharmax_command_sod_rejection_total{command_name}`                |   ✅   | same (one counter — `outcome=sod_rejected` on dispatched_total)                                                      |
| `pharmax_command_optimistic_concurrency_retry_total{command_name}` |   📋   | TODO — needs a CAS retry hook in `execute-command.ts`                                                                |
| `pharmax_audit_log_rows_total{organization_id}`                    |   ✅   | `packages/audit/src/chain/writer.ts`                                                                                 |
| `pharmax_audit_verifier_failures_total{organization_id}`           |   ✅   | `packages/audit/src/chain/verifier.ts` (sequence / prevHash / entryHash breaks)                                      |
| `pharmax_audit_manifest_latest_signed_at_seconds{organization_id}` |   ✅   | `apps/worker/src/security/daily-merkle-root-loop.ts` (ObservableGauge)                                               |
| `pharmax_workflow_stage_duration_seconds{kind}`                    |   ✅   | `packages/sla/src/interval-recorder.ts` (close-side histogram)                                                       |
| `pharmax_workflow_queue_depth{stage, organization_id}`             |   ✅   | `apps/worker/src/metrics/workflow-bucket-scraper.ts` (ObservableGauge, scraped)                                      |
| `pharmax_workflow_emergency_bucket_size{organization_id}`          |   ✅   | same                                                                                                                 |
| `pharmax_shipping_bucket_size{bucket}`                             |   ✅   | same (`bucket="EXCEPTION"`)                                                                                          |
| `pharmax_workflow_sla_breaches_total{stage}`                       |   ✅   | `apps/worker/src/drains/sla-breach-evaluator.ts` (first-time escalation; `stage` = SLA interval kind at breach time) |
| `pharmax_shipping_tracking_poll_duration_seconds{carrier}`         |   ✅   | `apps/worker/src/drains/{fedex,ups}-tracking-poller.ts`                                                              |
| `pharmax_shipping_tracking_poll_failures_total{carrier}`           |   ✅   | same                                                                                                                 |
| `pharmax_shipping_tracking_events_recorded_total{carrier}`         |   ✅   | same                                                                                                                 |
| `pharmax_shipping_escalations_created_total`                       |   ✅   | `apps/worker/src/drains/escalate-on-shipment-exception.ts`                                                           |
| `pharmax_billing_invoice_lines_created_total`                      |   ✅   | `apps/worker/src/drains/materialize-billing-on-order-shipped.ts`                                                     |
| `pharmax_billing_invoice_finalized_total`                          |   ✅   | `packages/billing/src/commands/finalize-invoice.ts`                                                                  |
| `pharmax_billing_stripe_push_total{outcome}`                       |   ✅   | `apps/worker/src/drains/push-invoice-to-stripe.ts` (success / fail / skipped)                                        |
| `pharmax_billing_refunds_issued_total`                             |   ✅   | `apps/worker/src/drains/stripe-handlers.ts`                                                                          |
| `pharmax_kms_operation_errors_total{operation}`                    |   ✅   | `packages/crypto/src/aws-kms-client.ts`                                                                              |
| `pharmax_outbox_dispatched_total{event_type, outcome}`             |   ✅   | `apps/worker/src/drains/event-outbox-drainer.ts`                                                                     |
| `pharmax_outbox_dead_total{event_type}`                            |   ✅   | same                                                                                                                 |
| `pharmax_outbox_claim_lag_seconds`                                 |   ✅   | same — histogram                                                                                                     |

**On the one remaining 📋 entry.** It is an intentional follow-up:

- `pharmax_command_optimistic_concurrency_retry_total` — Pharmax does not run a
  generic CAS retry loop inside `execute-command.ts` today; commands that need
  optimistic concurrency surface `STALE_ORDER` directly so the caller can decide
  whether to retry. If/when we add a transparent retry inside the bus, this is
  the metric to wire.

The single alert referencing this series in
[`prometheus/rules/alert-rules.yaml`](./prometheus/rules/alert-rules.yaml) fails
closed (evaluates to `0`) until the meter lands.

### Smoke-testing the wired metrics locally

```bash
# 1. Start the local observability stack
docker compose -f observability/docker-compose.yml up -d

# 2. Boot the worker pointed at it
OTEL_ENABLED=true \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=pharmax-worker \
pnpm --filter @pharmax/worker start

# 3. Query Prometheus
curl -s 'http://localhost:9090/api/v1/label/__name__/values' \
  | jq '.data[] | select(startswith("pharmax_"))'
```

You should see the `pharmax_outbox_*`, `pharmax_workflow_queue_depth`,
`pharmax_workflow_emergency_bucket_size`, and `pharmax_audit_manifest_latest_signed_at_seconds`
series appear within ~30s of boot (the worker's scraper interval). Other metrics
populate once their respective commands / drainers run.

---

## Safety properties

1. **No PHI in this directory.** Tenant identity in labels is the opaque
   organization UUID only. Patient identifiers are never labels.
2. **No real secrets.** Grafana admin password in `docker-compose.yml` is the
   default `admin/admin` for local dev only; prod uses SSO. Datadog / Grafana
   Cloud tokens are referenced as collector env vars, never committed.
3. **Defense in depth on PHI labels.** The collector includes a defensive
   `attributes` processor that drops attribute keys matching the PHI sentinel
   list, even though the emit-side prevents them. See [`collector/README.md`](./collector/README.md).
4. **Tenant id, not tenant name** in alerts and dashboards. Operators look up
   the human-readable name in the admin tool, not in Slack alert text.

---

## When something fires

Every alert in [`prometheus/rules/alert-rules.yaml`](./prometheus/rules/alert-rules.yaml)
includes a `runbook_url` annotation pointing at one of the docs in
[`runbooks/`](./runbooks/). The runbooks are intentionally short — symptoms,
likely causes, investigation, mitigation, escalation, postmortem link — so a
half-asleep on-call engineer can act fast.
