# Synthetics module — outside-in heartbeat canary

## Why this exists

Every alarm in [`modules/cloudwatch`](../cloudwatch/main.tf) watches the
platform from the **inside**: ECS task counts, RDS metrics, ALB target
metrics, app-emitted custom metrics. All of them share one blind spot —
they cannot see a failure that sits **in front of** the ALB:

- DNS misconfiguration or an expired zone delegation
- An expired or mis-issued TLS certificate
- CloudFront misrouting or a distribution-level failure
- A WAF rule blocking all traffic
- A region-level network problem between the internet and the ALB

Any of those takes the pharmacy console away from every user while every
internal alarm stays green. This module closes the gap with a CloudWatch
Synthetics canary that requests the public health endpoint from AWS's
synthetics fleet — **outside the VPC** — every minute, plus a
critical-tier alarm on its `SuccessPercent` metric.

## What it covers

- The full public ingress path: DNS → TLS → CloudFront → WAF → ALB →
  ECS web task, ending at `GET /api/health`
  ([`apps/web/app/api/health/route.ts`](../../../../apps/web/app/api/health/route.ts)),
  the app's deliberate no-auth liveness probe.
- The response contract: HTTP 200 and a JSON body with `status: "ok"`.
- Continuity of monitoring itself: the alarm treats **missing data as
  breaching**, so a canary that silently stops running becomes a page,
  not a blind spot.

## What it deliberately does NOT cover

- **No authenticated flows.** The canary holds no credentials, no
  session cookie, and never touches a route behind sign-in. It proves
  the platform is _reachable_, not that the operator console _works_.
  Authenticated journey canaries are a future, separate decision — they
  require a dedicated synthetic user, credential storage, and a PHI-free
  test tenant.
- **No correctness checks.** `/api/health` intentionally pings neither
  Postgres nor Redis (see the comment in the route). A green canary
  with a broken database is possible; that combination is covered by
  the ALB 5xx and RDS alarms.
- **No print-agent or worker coverage.** Those services have no public
  surface; their alarms live in `modules/cloudwatch`.

## Resources

| Resource                                        | Purpose                                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws_synthetics_canary.heartbeat`               | Runs `canary/heartbeat.js` on `rate(1 minute)` using the `syn-nodejs-puppeteer` runtime.                                                      |
| `aws_cloudwatch_metric_alarm.heartbeat_failed`  | Critical tier. `SuccessPercent < 100` for 2×5 min, or missing data. Routes to the critical SNS topic.                                         |
| `aws_s3_bucket.artifacts` (+ policy, lifecycle) | Run artifacts (HAR files, logs). SSE-S3, TLS-only, public access blocked, expired after 31 days.                                              |
| `aws_iam_role.canary` (+ inline policy)         | Least privilege: write to the one artifact prefix, publish to the `CloudWatchSynthetics` namespace, write its own `/aws/lambda/cwsyn-*` logs. |

The severity contract is the same two-topic split as `modules/cloudwatch`,
and `scripts/check-alarm-actions.ts` guards this file's alarm wiring too
(it is listed in `ALARM_MODULE_FILES`).

## Wiring

Enabled per env-region via `enable_synthetics` (default `false`); the root
composition derives the target URL from `app_url`:

```hcl
module "synthetics" {
  count  = var.enable_synthetics ? 1 : 0
  source = "./modules/synthetics"

  name_prefix   = local.name_prefix
  heartbeat_url = "${var.app_url}/api/health"

  critical_alarm_sns_topic_arn = try(module.alerting[0].critical_topic_arn, "")
  ...
}
```

Note the canary **name** is truncated to the 21-character Synthetics
limit (`substr("${name_prefix}-hb", 0, 21)`); the alarm and bucket carry
the full prefix.

## Operating it

- Runbook for the alarm:
  [`docs/runbooks/alarms/synthetics-heartbeat-failed.md`](../../../../docs/runbooks/alarms/synthetics-heartbeat-failed.md)
- The runtime version (`runtime_version` variable) is on AWS's
  deprecation treadmill — expect to bump it roughly yearly. Script uses
  the `@aws/synthetics-*` namespace, so any runtime ≥ 13.1 works.
- Stopping the canary (`aws synthetics stop-canary`) will page within
  ~10 minutes, because missing data breaches. That is intentional; if
  you mean to silence it, disable the alarm's actions for the window and
  say so in the incident channel.

## This module has never been applied

As of the PR that introduced it, this module is **code only** — reviewed,
`terraform fmt`- and `validate`-clean, but not applied to any
environment. The first apply happens through the normal reviewer-gated
`terraform-apply.yml` dispatch.
