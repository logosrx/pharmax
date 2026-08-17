# Grafana Cloud OTel backend — setup runbook

Production OpenTelemetry export for Pharmax goes **directly from the web and
worker tasks to the Grafana Cloud OTLP gateway** (OTLP/HTTP). There is no
collector sidecar in this path — `@pharmax/telemetry` batches and exports from
inside the app process (see `packages/telemetry/src/resolve-config.ts`), so
the only production wiring needed is an endpoint, an auth header, and the
Terraform that injects both. That wiring landed opt-in and **off by default**;
this runbook is the flip procedure.

## What Terraform wires (already merged)

| Thing                            | Name                                                                      |
| -------------------------------- | ------------------------------------------------------------------------- |
| Opt-in flag (tfvar)              | `otel_backend_enabled` (default `false`)                                  |
| Endpoint (tfvar → plain env var) | `otel_exporter_otlp_endpoint` → `OTEL_EXPORTER_OTLP_ENDPOINT`             |
| Auth header (secret → env var)   | `<name_prefix>/grafana-cloud-otlp-headers` → `OTEL_EXPORTER_OTLP_HEADERS` |
| Services that export             | web + worker (print-agent excluded — it runs at `desired_count = 0`)      |

For prod/us-east-1 the secret is `pharmax-prod-ue1/grafana-cloud-otlp-headers`
(the `<name_prefix>` pattern is `pharmax-<env>-<region-shortcode>` — see
`infra/terraform/locals.tf`; `ue1` is canonical for us-east-1). The secret
ships with a placeholder value; Terraform ignores out-of-band changes to it
(`lifecycle.ignore_changes`), so pasting the real value in the console or CLI
will **not** be reverted by the next apply.

`OTEL_ENABLED` needs no wiring: it defaults to `true` when
`NODE_ENV=production`. Trace sampling defaults to 10% in production
(`OTEL_TRACES_SAMPLER_ARG` overrides).

## Flip procedure

### 1. Create the Grafana Cloud stack

Sign up at [grafana.com](https://grafana.com/auth/sign-up/create-user) — the
free tier is fine to start (10k metric series, 50 GB traces/logs per month at
the time of writing). Create a stack; pick the region closest to us-east-1.

### 2. Find the OTLP gateway endpoint + instance ID

In the [Grafana Cloud portal](https://grafana.com/profile/org), open your
stack and click **Configure** on the **OpenTelemetry** card. That page shows:

- the OTLP endpoint, shaped `https://otlp-gateway-<region>.grafana.net/otlp`
  — region-specific to _your stack_, not to AWS;
- the **instance ID** (a numeric ID, e.g. `1234567`).

Copy both exactly. A wrong-region endpoint fails auth because tokens are
stack-scoped.

### 3. Generate a token

On the same page (or **Security → Access Policies**), create an access policy
scoped to this stack with **`metrics:write`, `traces:write`, `logs:write`**,
then create a token under it. Copy the token (`glc_...`) — it is shown once.

### 4. Base64 the `instanceId:token` pair

```bash
printf '%s' '1234567:glc_REDACTED' | base64
```

Use `printf '%s'` (not `echo`) so no trailing newline gets encoded — a
newline inside the Basic credential fails auth in a way that is miserable to
debug.

### 5. Paste it into the AWS secret

```bash
aws secretsmanager put-secret-value \
  --secret-id pharmax-prod-ue1/grafana-cloud-otlp-headers \
  --secret-string "Authorization=Basic <base64-from-step-4>"
```

The value is the full comma-separated `k=v` header list the telemetry package
parses — for Grafana Cloud that is the single `Authorization=Basic ...` pair.
Never commit this value anywhere; the token is a write credential.

### 6. Flip the tfvar and apply

In `infra/terraform/environments/prod/us-east-1/terraform.tfvars`:

```hcl
otel_backend_enabled        = true
otel_exporter_otlp_endpoint = "https://otlp-gateway-<region>.grafana.net/otlp" # exact URL from step 2
```

Apply through the gated terraform-apply workflow (or `make plan-prod-ue1` +
operator apply). The plan should show exactly: new task-definition revisions
for web + worker (two env/secret entries each) — nothing else.

### 7. Roll the services onto the new revision

The ECS services set `ignore_changes = [task_definition]`, so the apply
registers new revisions but does **not** move running tasks onto them. Either
dispatch the deploy workflow (`deploy.yml` — it derives its task definition
from the latest registered revision, which now carries the OTel vars), or
roll manually:

```bash
aws ecs update-service --cluster pharmax-prod-ue1-cluster \
  --service pharmax-prod-ue1-web --task-definition pharmax-prod-ue1-web \
  --force-new-deployment
aws ecs update-service --cluster pharmax-prod-ue1-cluster \
  --service pharmax-prod-ue1-worker --task-definition pharmax-prod-ue1-worker \
  --force-new-deployment
```

(Passing the family name without a revision selects the latest revision.)

## Verifying ingest

In your Grafana Cloud instance, open **Explore**:

- **Traces (Tempo)** — select the `grafanacloud-<stack>-traces` datasource and
  search for `service.name = pharmax-web` (or `pharmax-worker`). Spans should
  appear within a minute or two of the rollout. Remember production samples
  traces at 10% — a quiet stack needs a few requests before anything shows.
- **Metrics (Mimir/Prometheus)** — select `grafanacloud-<stack>-prom` and
  query `pharmax_outbox_dispatched_total` or `pharmax_workflow_queue_depth`
  (the worker emits these within ~30s of boot; see
  `observability/README.md` for the full metric inventory).

If nothing arrives: check the web/worker CloudWatch logs for OTLP exporter
errors — a `401` means the secret value or endpoint region is wrong; re-do
steps 2–5 and force a new deployment (the task reads the secret at boot).

## Pointing the dashboards at Grafana Cloud (not done in this change)

The six dashboards under `observability/grafana/dashboards/` are
vendor-neutral in their queries but hardcode local datasource UIDs
(`prometheus`, `tempo`, `loki` — matching
`observability/grafana/provisioning/datasources/`). Grafana Cloud's managed
datasources have different UIDs (`grafanacloud-<stack>-prom`, etc.), so
loading them there needs one of:

- **Manual import** (fastest): Dashboards → Import → upload each JSON; the
  import dialog prompts for a datasource mapping per UID.
- **Dashboards-as-code**: replace the hardcoded UIDs with a
  `${DS_PROMETHEUS}`-style templated datasource variable (or re-provision
  datasources in Grafana Cloud with the same UIDs via the Grafana Terraform
  provider), then sync via provisioning.

Either is a deliberate follow-up — this change is transport wiring only. The
Prometheus alert rules in `observability/prometheus/rules/` would similarly
port to Grafana Cloud–managed alerting as a follow-up.

## Rotation and rollback

- **Rotate the token**: create a new token under the same access policy,
  re-run steps 4–5, then force a new deployment (tasks read the secret at
  boot only). Delete the old token in Grafana Cloud afterwards.
- **Turn it off**: set `otel_backend_enabled = false`, apply, roll the
  services. The env vars disappear and telemetry reverts to its no-backend
  localhost default. Nothing else to clean up.

## Safety notes

- No PHI leaves the platform through this path: metric labels and span
  attributes carry opaque tenant UUIDs only (see `observability/README.md`
  § Safety properties), and the telemetry package never logs header values.
- The secret's placeholder value fails gateway auth harmlessly (the exporter
  logs and retries; the app keeps serving) — but do not flip the tfvar before
  populating the real value, per the ordering above.
