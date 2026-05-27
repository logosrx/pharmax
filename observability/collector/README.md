# OpenTelemetry Collector — Pharmax pipeline

This collector receives OTLP from every Pharmax Node process via
`@pharmax/telemetry` and fans the signals out to Prometheus, Tempo, and Loki.
It is the **single ingress hop** for all telemetry — apps never talk directly
to Prometheus / Tempo / Loki / vendor APIs.

## Pipeline overview

```
+-----------------+        OTLP/HTTP :4318         +------------------+
| pharmacy-web    | ---------------------------->  |                  |
| pharmacy-worker | ---------------------------->  | otel-collector   |  -- :8889  -->  Prometheus (scrape)
| pharmacy-print- | ---------------------------->  |   - memory_limit |  -- :4318  -->  Tempo (OTLP)
|   agent         |                                |   - PHI scrub    |  -- :3100  -->  Loki (push)
+-----------------+                                |   - resource det |  -- (opt)  -->  Datadog / Grafana Cloud
                                                   |   - batch        |
                                                   +------------------+
```

## Receivers

- **OTLP/HTTP** on `:4318` — matches the `OTEL_EXPORTER_OTLP_ENDPOINT` default
  in `packages/telemetry/src/resolve-config.ts` (`http://localhost:4318`).
  CORS is open to `http://localhost:*` in dev for browser RUM experiments; do
  not loosen this in prod.
- **OTLP/gRPC** on `:4317` — provided for any future Go/Java services we add
  (Node OTLP/HTTP exporter cannot speak gRPC).
- **Prometheus self-scrape** on `:8888` — the collector exposes its own
  metrics; we scrape them so we can dashboard the collector itself (queue
  depth, dropped spans, refused export batches).

## Processors

Order in the pipeline is significant and is enforced by the spec:

1. **`memory_limiter`** — first. Drops incoming data if the collector's
   memory pressure exceeds 80% of the cgroup limit. Prevents the OOM-kill
   loop that destroys all telemetry across a deploy.
2. **`attributes/phi_scrub`** — **defense in depth**. The emit-side code
   never attaches PHI to attributes, but a bug in instrumentation or a
   third-party library could. This processor explicitly drops any attribute
   key in the PHI sentinel list. The signal still flows; the attribute is
   gone. The sentinel list, in [`config.yaml`](./config.yaml):

   | Identity / contact                             | Health / clinical          | Account / payment              |
   | ---------------------------------------------- | -------------------------- | ------------------------------ |
   | first_name, last_name, full_name, patient_name | mrn, medical_record_number | rx_number, prescription_number |
   | patient.first_name, patient.last_name          | drug_name, medication      |                                |
   | dob, date_of_birth                             | diagnosis, icd10           |                                |
   | ssn, ssn_last4                                 | notes                      |                                |
   | phone, phone_number, mobile                    |                            |                                |
   | email, email_address                           |                            |                                |
   | address, street_address, address_line_1/2      |                            |                                |
   | postal_code, zip                               |                            |                                |
   | patient (the entire "patient.\*" namespace)    |                            |                                |

   This list intentionally overlaps with the Pino redactor in
   `packages/platform-core/src/logger/redaction.ts` and the Sentry
   scrubber in `apps/web/src/server/observability/sentry-scrubber.ts`.
   The three layers all enforce the same allowlist independently —
   that is the point. If a new PHI-bearing key is ever introduced,
   update **all three** plus this list.

3. **`resourcedetection`** — non-destructive enrichment with host /
   container / cloud attributes. Detects ECS task arn + EC2 instance id in
   production so dashboards can group by AZ / host. `override: false` is
   important — apps' explicit resource attributes always win.
4. **`batch`** — last. Batches signals for efficient export. The current
   settings (`send_batch_size: 8192`, `timeout: 10s`) are conservative; tune
   per environment based on observed export latency.

## Exporters

- **`prometheus`** (HTTP exposer on `:8889`) — Prometheus scrapes the
  collector at this endpoint. Histograms are converted to Prometheus
  histogram metrics; Pharmax cumulative counters keep their `_total`
  suffix.
- **`otlphttp/tempo`** — push traces to Tempo on `:4318` (Tempo speaks
  OTLP).
- **`loki`** — push logs to Loki. Apps emit structured Pino JSON to
  stdout; the runtime (Docker, ECS, Kubernetes) is responsible for
  shipping stdout into the OTel collector as the `logs` signal (via the
  OTLP/HTTP `logs` endpoint emitted by Pino's
  `pino-opentelemetry-transport`). For pure stdout → Loki without OTel,
  Promtail / Vector is an equivalent path; we standardize on OTel to
  keep ingress to one hop.
- **`datadog/all`** (commented) — uncomment in production to dual-ship
  to Datadog. Requires `DD_API_KEY` from Secrets Manager.
- **`prometheusremotewrite/grafana_cloud`** (commented) — same pattern
  for Grafana Cloud or AWS Managed Prometheus.

## Extensions

- **`health_check`** on `:13133` — load balancers / ECS health checks
  hit this.
- **`pprof`** on `:1777` — runtime profiling for collector itself.
- **`zpages`** on `:55679` — `/debug/pipelinez` shows pipeline state in
  the browser.

## Secrets

The collector reads only environment variables for vendor credentials.
None of those variables are committed.

| Variable                   | When needed                           |
| -------------------------- | ------------------------------------- |
| `DD_API_KEY`               | Datadog exporter                      |
| `GC_PROM_REMOTE_WRITE_URL` | Grafana Cloud Prometheus remote write |
| `GC_PROM_TOKEN`            | Grafana Cloud bearer token            |
| `GC_LOKI_PUSH_URL`         | Grafana Cloud Logs                    |
| `GC_LOKI_TOKEN`            | Grafana Cloud Logs bearer token       |

In production the ECS task definition reads these from AWS Secrets
Manager. See `docs/security/secrets-management.md`.

## Running the collector locally

The local dev stack uses the contrib image (`otel/opentelemetry-collector-contrib`)
because the `loki` and `datadog` exporters are not in the core image:

```bash
docker compose -f observability/docker-compose.yml up otel-collector
```

Verify:

```bash
curl -fsS http://localhost:13133/      # health
curl -fsS http://localhost:55679/debug/pipelinez | head
```

Run a smoke test from one of the apps:

```bash
OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  pnpm --filter @pharmax/web dev
```

You should see resource-tagged spans in Tempo (`http://localhost:3001` →
Explore → Tempo), HTTP metrics in Prometheus (`http://localhost:9090` →
Graph → `http_server_request_duration_seconds_bucket`), and logs in
Loki.

## Why one collector hop (and not multiple)

A single hop means one place to audit for PHI scrubbing, one place to
fan out to multiple backends, and one place to add vendor credentials.
The apps don't carry vendor secrets and don't know about backend choice.
That is the correct shape for a HIPAA-eligible signal path.
