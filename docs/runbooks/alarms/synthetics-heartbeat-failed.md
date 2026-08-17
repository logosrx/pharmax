# `<prefix>-synthetics-heartbeat-failed`

> Commands below use the primary-region prefix `pharmax-prod-ue1`.
> The canary itself is named with a truncated prefix (21-char Synthetics
> limit): `pharmax-prod-ue1-hb` in the primary region.

## What fired and what it means

- **Metric:** `SuccessPercent` (`CloudWatchSynthetics` namespace, dimension
  `CanaryName`), Average.
- **Threshold:** < 100%, **2 × 5-minute periods** (any failing runs for ~10
  minutes). **Missing data breaches** — a canary that stopped running is
  external monitoring silently switched off.
- **User-visible symptom:** the public health endpoint
  (`GET https://app.pharmax.co/api/health`) is failing **from the
  internet**. This is the outside-in check: it exercises DNS → TLS →
  CloudFront → WAF → ALB → ECS web. When it fails and internal alarms are
  green, the failure is in front of the ALB — users cannot reach the
  console at all, partners cannot reach the API, and nothing inside AWS
  will say so.

Defined in
[`infra/terraform/modules/synthetics/main.tf`](../../../infra/terraform/modules/synthetics/main.tf)
(`heartbeat_failed`); module scope and non-goals in the
[module README](../../../infra/terraform/modules/synthetics/README.md).

## Severity + who is paged

**Critical** → `pharmax-prod-ue1-alerts-critical` SNS topic → paging
provider + on-call mailbox.

## First 5 minutes

1. **Is it everyone, or just the canary?** From your own machine:

   ```bash
   curl -sv https://app.pharmax.co/api/health | tail -5
   ```

   `{"status":"ok",...}` from your machine + canary failing = suspect the
   canary (see false positives). Failing for you too = real outage;
   continue.

2. **Which layer?** The curl verbose output localizes it: DNS resolution
   failure ≠ TLS failure ≠ HTTP 5xx ≠ WAF 403 ≠ timeout. Each points at a
   different layer of the ingress path.
3. **What does the canary itself say?**

   ```bash
   aws synthetics get-canary-runs --name pharmax-prod-ue1-hb --max-results 5 \
     --query 'CanaryRuns[].{status:Status.State,reason:Status.StateReason,started:Timeline.Started}'
   ```

   The `reason` carries the script's own error ("Expected HTTP 200, got
   503", timeout, DNS failure). Artifacts (HAR + logs) are in the
   `pharmax-prod-ue1-synthetics-artifacts-*` bucket.

4. **Cross-check the internal alarms.**
   - [`alb-5xx-rate`](alb-5xx-rate.md) or
     [`ecs-web-running-low`](ecs-running-low.md) also firing → the app is
     down; work those runbooks.
   - Internal alarms **green** → the failure is in front of the ALB: check
     the certificate (`aws acm list-certificates`), the CloudFront
     distribution status, and the WAF (a rule blocking everything shows as
     403s in the WAF metrics, zero requests reaching the target group).
5. **Grafana:** _Pharmax · Platform Health_ → “Request rate (per second, by
   service)” — traffic falling to zero while tasks are healthy is the
   fingerprint of an ingress-layer failure.

## Likely causes (ranked)

1. **The app is down** — web tasks failing; the internal alarms are firing
   too and are more specific. This canary adds nothing new; it confirms
   user impact.
2. **Certificate expiry or DNS change** — internal alarms green, curl fails
   at TLS/resolution. The classic silent killer this canary exists for.
3. **WAF rule change blocking legitimate traffic** — 403s at the WAF, zero
   target-group traffic.
4. **CloudFront misconfiguration or distribution failure** — origin errors
   at the edge while the ALB is healthy.
5. **The canary itself broke** — a runtime deprecation
   (`syn-nodejs-puppeteer-*` versions are deprecated on a schedule), an
   expired execution role, or someone stopped the canary. Missing data
   breaching means "stopped" fires this alarm within ~10 minutes.

## Mitigations

- App down → work the specific internal runbook
  ([alb-5xx-rate](alb-5xx-rate.md), [ecs-running-low](ecs-running-low.md)).
- Certificate / DNS / WAF / CloudFront fixes are **Terraform changes
  through the reviewer-gated apply** — wake the approver at the same time
  you diagnose. A console hot-fix is drift the nightly plan will flag; if
  you must hot-fix, say so in the incident record and reconcile in the
  morning.
- Canary broken (not the platform): restart it —

  ```bash
  aws synthetics start-canary --name pharmax-prod-ue1-hb
  ```

  A deprecated runtime needs a `runtime_version` bump in
  `modules/synthetics` via a normal PR + apply.

## Escalation

- Real external unreachability = **SEV1** — every user and partner is
  locked out even if the app is healthy inside.
- Declare per [incident response](../../INCIDENT_RESPONSE.md); mechanics in
  the [alerting runbook](../alerting.md).

## False-positive notes

- The quarterly **fire drill** (`aws cloudwatch set-alarm-state`) — check
  `StateReason`.
- **A stopped canary** (maintenance, cost-saving, someone testing) fires
  via the missing-data path. If stopping it was intentional, disable the
  alarm's actions for the window and say so — do not let it sit in ALARM.
- **The apply that creates the canary pages once.** The canary and this
  alarm are created by the same apply, seconds apart, and the alarm's first
  evaluation lands before the canary has published a single
  `SuccessPercent` datapoint — so missing data breaches exactly as designed
  and the page goes out. The first successful run clears it about a minute
  later. The tell is the transition itself: `INSUFFICIENT_DATA -> ALARM`
  rather than `OK -> ALARM`, because a real outage always arrives from OK.

  ```bash
  aws cloudwatch describe-alarm-history \
    --alarm-name pharmax-prod-ue1-synthetics-heartbeat-failed \
    --history-item-type StateUpdate \
    --query 'reverse(sort_by(AlarmHistoryItems,&Timestamp))[].[Timestamp,HistorySummary]' \
    --output text

  aws synthetics get-canary --name pharmax-prod-ue1-hb \
    --query 'Canary.Timeline.Created'
  ```

  A `Created` timestamp within a minute of the ALARM, plus zero non-`PASSED`
  runs in `get-canary-runs`, settles it — and CloudTrail's `CreateCanary`
  event names the apply run that did it. This happened on 2026-08-17 when
  the canary first reached production; it cannot recur unless the canary is
  destroyed and recreated.

- **Synthetics-fleet or single-run flakes:** a lone failed run inside one
  5-minute window can dip `SuccessPercent` below 100 for that period; the
  2-period requirement filters one-offs. If flakes recur without any real
  impact, tune `alarm_evaluation_periods` or the threshold in
  `modules/synthetics` via PR — do not mentally downgrade a critical alarm.
- This canary does **not** test authenticated flows or the database
  (`/api/health` deliberately pings neither Postgres nor Redis) — a green
  canary never disproves an application-level incident.
