# `<prefix>-alb-5xx-rate`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.
> Substitute `pharmax-prod-uw2` in the DR region.

## What fired and what it means

- **Metric:** `HTTPCode_Target_5XX_Count / RequestCount * 100` (metric-math
  expression over `AWS/ApplicationELB`, dimension `LoadBalancer`).
- **Threshold:** > 1% (`alb_5xx_threshold_percent`), **2 × 5-minute periods**
  (10 minutes sustained). Missing data does not breach.
- **User-visible symptom:** pharmacists and partner API clients are getting
  errors _right now_ — orders failing to save, verifications failing to
  record, labels failing to queue, partners getting 5xx on prescription
  submission (`/api/v1/*` rides the same ALB).

Defined in
[`infra/terraform/modules/cloudwatch/main.tf`](../../../infra/terraform/modules/cloudwatch/main.tf)
(`alb_5xx_rate`).

## Severity + who is paged

**Critical** → `pharmax-prod-ue1-alerts-critical` SNS topic → paging provider
webhook + on-call mailbox. You were paged; act now.

## First 5 minutes

1. **Was there a deploy?** The single most likely cause.

   ```bash
   aws ecs describe-services --cluster pharmax-prod-ue1 \
     --services pharmax-prod-ue1-web \
     --query 'services[0].deployments[].{status:status,createdAt:createdAt,image:taskDefinition,running:runningCount}'
   ```

   A deployment created within minutes of the alarm start is your suspect.
   Note: the ECS deployment circuit breaker may have **already rolled back**
   — check whether the active task definition matches what was dispatched.

2. **How big is it?** 1% of overnight traffic can be a handful of requests.

   ```bash
   aws cloudwatch get-metric-statistics --namespace AWS/ApplicationELB \
     --metric-name RequestCount --statistics Sum --period 300 \
     --dimensions Name=LoadBalancer,Value=$(aws elbv2 describe-load-balancers \
       --names pharmax-prod-ue1-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text | cut -d/ -f2-) \
     --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ) --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)
   ```

   Repeat with `--metric-name HTTPCode_Target_5XX_Count` for the numerator.

3. **What is erroring?** Logs Insights on the web log group:

   ```bash
   aws logs start-query --log-group-name /ecs/pharmax-prod-ue1/web \
     --start-time $(($(date +%s) - 1800)) --end-time $(date +%s) \
     --query-string 'fields @timestamp, @message | filter @message like /"level":"error"/ | stats count() by bin(5m)'
   ```

   Then re-run without `stats` and read the dominant error. **Never paste log
   lines containing identifiers into the incident channel** — log fields are
   PHI-free by policy, but treat excerpts with care anyway.

4. **Grafana:** _Pharmax · Platform Health_ → **“5xx error ratio (by
   service)”** tells you whether web alone or web+worker-facing dependencies
   are erroring; **“Latency p50 / p95 / p99 (by service)”** distinguishes
   fail-fast (bug) from timeout (dependency). _Pharmax · Command Bus_ →
   **“Error ratio by command_name”** narrows it to one command if the failures
   are write-path.

5. Check Sentry for the dominant exception on the current release.

## Likely causes (ranked)

1. **A bad release.** The deploy matrix rolls web, worker, print-agent
   independently and the circuit breaker rolls back a service whose tasks
   fail to boot — a _partial_ failure leaves production on **mixed
   versions**, which itself produces 5xx (schema/contract skew between web
   and worker).
2. **A dependency down** (Stripe, EasyPost, Resend, Twilio): one exception
   class dominating Sentry, errors confined to routes touching that
   integration.
3. **Database trouble:** check whether `rds-connections-high` or
   `rds-freeable-memory-low` is also firing — connection exhaustion looks
   like a total 5xx outage.
4. **Web tasks dying under load:** memory kills show in
   `ecs-web-running-low` or the service events.

## Mitigations

- **Roll back the release** — follow
  [RUNBOOK § Rolling back a deploy](../../RUNBOOK.md#rolling-back-a-deploy).
  Requires a human: `deploy.yml` is dispatch-only and the `production`
  environment needs a reviewer. **Wake the approver at the same time you
  start diagnosing**, not after.
- **Scale web** (human decision — cost + masking a bug):

  ```bash
  aws ecs update-service --cluster pharmax-prod-ue1 \
    --service pharmax-prod-ue1-web --desired-count 6
  ```

  Note web autoscales 3–20 on CPU already; manual scaling only helps if the
  errors are load-shaped, and `desired_count` drift is ignored by Terraform.

- **Restart tasks** (safe if state-corruption is suspected):
  `aws ecs update-service ... --force-new-deployment`.
- After ANY mitigation deploy: **confirm the running image tag of every
  service**, not just web — mixed versions is the trap.

## Escalation

- SEV2 if a subset of routes; **SEV1 if error rate > ~20% or login is
  affected**.
- Declare per [`docs/INCIDENT_RESPONSE.md`](../../INCIDENT_RESPONSE.md); the
  paging/approval mechanics are in the
  [alerting fire-drill runbook](../alerting.md).

## False-positive notes

- The quarterly **alerting fire drill** forces alarms into ALARM with
  `aws cloudwatch set-alarm-state` (see
  [alerting runbook § Proving the pipe works](../alerting.md#proving-the-pipe-works)).
  Check the alarm's `StateReason` — a drill says so explicitly.
- **Low-traffic arithmetic:** 1% of 40 requests is one request. Check
  `RequestCount` before believing the percentage.
- Load tests, security scans, or a known third-party outage already being
  tracked can push the ratio over 1% without a platform fault.
