# Alerting runbook

**Audience:** whoever is on call. Read the two sections below
("Before you are paged" and "Routing") once, in daylight, before your
first shift. The per-alarm entries are reference material for 03:00.

**Scope:** every CloudWatch alarm the Pharmax production stack
creates, which tier it routes to, and what to do when one fires.
Infrastructure lives in
[`infra/terraform/modules/cloudwatch`](../../infra/terraform/modules/cloudwatch/main.tf)
(the alarms) and
[`infra/terraform/modules/alerting`](../../infra/terraform/modules/alerting/main.tf)
(the topics). Application-level observability — logs, Sentry, traces,
the audit chain — is [`../OBSERVABILITY.md`](../OBSERVABILITY.md).
Procedures for things that break after a deploy are
[`../RUNBOOK.md`](../RUNBOOK.md); this document routes you there rather
than duplicating them.

> **History.** Until 2026-08-03 production ran with
> `alarm_sns_topic_arn = ""`. All sixteen alarms evaluated correctly,
> transitioned to ALARM correctly, and notified nobody. If you are
> reading an incident timeline from before that date, absence of an
> alert means nothing.

---

## Before you are paged

Three properties of this deployment change what you can promise during
an incident. Learn them now, not while a pharmacist is on the phone.

**A fix cannot ship on your authority alone.**
[`deploy.yml`](../../.github/workflows/deploy.yml) is
`workflow_dispatch`-only, and the `production` GitHub Environment
requires a reviewer. You dispatch the deploy; it then sits in
`waiting` until a human with approval rights clicks. So the honest
mitigation sequence during an incident is: **wake the approver at the
same time you start working**, not after you have a candidate build.
The same applies to any fix that needs an infrastructure change —
`terraform-apply.yml` is dispatch-only and reviewer-gated too, so
"bump the instance class" is a 20-minute-plus path with a human in it,
not a lever you pull.

**Merging to `main` has not shipped anything.** Never assume the
running image matches `main`. Check the image tag on the running task
definition before you reason about which code is live.

**A partial deploy leaves production on mixed versions.** The deploy
matrix rolls web, worker, and print-agent independently, and the ECS
circuit breaker rolls a single service back on boot failure. After any
deploy — including your own mitigation — confirm the running image tag
of **every** service, not just the one you cared about.

**Nothing in an alarm notification contains PHI.** Alarm payloads are
an alarm name, a metric, a threshold, and a state transition. If you
ever see patient data in an alert, that is itself an incident: see
[`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md).

---

## Routing

Two topics, per region. `<prefix>` is `pharmax-prod-ue1` in the
primary region and `pharmax-prod-uw2` in the DR region.

| Topic                      | Meaning                                                                                                | Subscribers                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `<prefix>-alerts-critical` | Wake a human now. Availability, data integrity, or a capacity cliff minutes away from becoming either. | Paging provider webhook + on-call mailbox as a backstop |
| `<prefix>-alerts-warning`  | Read at shift start. Degradation and capacity planning.                                                | Ticket-creating address / mailbox                       |

Both topics are encrypted with the `<prefix>-alerts` CMK (key #9 in
[`../security/kms-key-inventory.md`](../security/kms-key-inventory.md)),
and their policy only accepts publishes from `cloudwatch.amazonaws.com`
for alarms named `<prefix>-*` in this account.

| Alarm                                  | Tier         | Fires when                                                                              |
| -------------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| `<prefix>-alb-5xx-rate`                | **critical** | Target 5xx > 1% of requests, 2 × 5 min                                                  |
| `<prefix>-rds-connections-high`        | **critical** | Writer `DatabaseConnections` > 200 avg, 2 × 5 min                                       |
| `<prefix>-rds-freeable-memory-low`     | **critical** | Writer `FreeableMemory` < 1 GiB, 2 × 5 min                                              |
| `<prefix>-ecs-web-running-low`         | **critical** | Web running tasks < 1, 2 × 1 min (missing = breaching)                                  |
| `<prefix>-ecs-worker-running-low`      | **critical** | Worker running tasks < 1, 2 × 1 min (missing = breaching)                               |
| `<prefix>-audit-chain-integrity`       | **critical** | Any non-zero `AuditChainIntegrityFailure` in 5 min                                      |
| `<prefix>-outbox-stalled`              | **critical** | Oldest undispatched outbox row > 1 h, 3 × 5 min                                         |
| `<prefix>-alb-target-p99`              | warning      | Web target p99 > 2 s, 3 × 5 min                                                         |
| `<prefix>-outbox-oldest-age-high`      | warning      | Oldest undispatched outbox row > 15 min, 3 × 5 min (missing = breaching)                |
| `<prefix>-outbox-dead-rows`            | warning      | Any DEAD `event_outbox` row — holds ALARM until replayed                                |
| `<prefix>-rds-cpu-high`                | warning      | Writer CPU > 80%, 2 × 5 min                                                             |
| `<prefix>-rds-replica-lag`             | warning      | `AuroraReplicaLag` > 30 s, 2 × 1 min                                                    |
| `<prefix>-ecs-<svc>-cpu-high`          | warning      | Service CPU > 80%, 3 × 5 min (web, worker, print-agent)                                 |
| `<prefix>-ecs-<svc>-mem-high`          | warning      | Service memory > 85%, 3 × 5 min                                                         |
| `<prefix>-ecs-print-agent-running-low` | warning      | Print-agent running tasks < 1 — **only exists when the stack intends the agent to run** |

Why the tiers fell where they did is recorded next to each alarm in
`modules/cloudwatch/main.tf` as a `# severity:` comment, and
`pnpm check:alarm-actions` fails the build if an alarm loses its
routing, its rationale, or if the two disagree.

---

## Critical tier

### `alb-5xx-rate`

**What it means.** More than 1% of requests reaching the web tasks
returned 5xx for ten minutes. Pharmacists are seeing errors: orders
failing to save, verifications failing to record, labels failing to
queue.

**First diagnostic step.** Compare the alarm's start time to the last
deploy. `aws ecs describe-services --cluster <prefix> --services
<prefix>-web --query 'services[0].deployments'` — if a deployment
started within a few minutes of the alarm, treat the release as the
suspect and go to
[RUNBOOK § Rolling back a deploy](../RUNBOOK.md#rolling-back-a-deploy).
If there was no deploy, check Sentry for the dominant exception on the
current release; a single failing dependency (Stripe, EasyPost, Clerk)
usually shows up as one exception class dominating.

**Escalation.** SEV2 if it is a subset of routes; SEV1 if the error
rate is above roughly 20% or login is affected. Page the deploy
approver as soon as a rollback looks likely — the dispatch waits for
them.

**Not actually an emergency when.** A load test, a security scan, or a
synthetic checker is generating the errors; the 5xx count is a handful
of requests against very low overnight traffic (1% of 40 requests is
one request — check `RequestCount` before you believe the percentage);
or a known third-party outage is already being tracked and the failures
are confined to that integration's retry path.

### `rds-connections-high`

**What it means.** The writer is averaging more than 200 connections.
The danger is not the number itself, it is the wall: when the instance
reaches `max_connections`, **new** connections are refused, which takes
out web and worker simultaneously and looks like a total outage.

**First diagnostic step.** Find out whether these are working
connections or leaked ones:

```sql
SELECT state, count(*) FROM pg_stat_activity GROUP BY state ORDER BY 2 DESC;
SELECT pid, state, now() - state_change AS idle_for, left(query, 80)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY state_change
LIMIT 20;
```

A pile of `idle in transaction` is a code path that opened a
transaction and did not close it — that is the leak. `pg_terminate_backend(pid)`
on the oldest offenders buys headroom immediately.

**Escalation.** SEV2 while connections are climbing but the app is
serving; SEV1 the moment `alb-5xx-rate` joins it (that combination is
the wall being hit). If the source is a task that keeps leaking,
restarting that service is the faster mitigation than terminating
sessions one at a time.

**Not actually an emergency when.** A migration, a backfill script, or
a restore drill is running and deliberately holding connections; or the
count rose because the web service scaled out during a legitimate
traffic peak and is still well under `max_connections` — check the
headroom, not the absolute number.

### `rds-freeable-memory-low`

**What it means.** The writer has less than 1 GiB of freeable memory.
Aurora will start pushing the buffer cache out, then swapping, and an
out-of-memory writer fails over. An unplanned failover drops every
in-flight transaction, mid-dispense included.

**First diagnostic step.** Performance Insights on the writer, sorted
by memory-heavy activity: look for a query with a large sort or hash
join, or a reporting query that escaped onto the writer instead of the
reader (`REPORTING_DATABASE_URL` should point at the reader endpoint —
confirm it does).

**Escalation.** SEV2. If freeable memory is still falling after you
have stopped the offending workload, a **deliberate** failover during a
quiet window is better than an uncontrolled one at an arbitrary moment;
that decision needs a second engineer, not a solo call.

**Not actually an emergency when.** A one-off analytical query has
already finished and the metric is recovering on its own; or the
instance was recently resized down and the threshold (1 GiB, set by
`rds_freeable_memory_low_threshold_bytes`) is simply wrong for the new
instance class — in that case the fix is a threshold change in tfvars,
filed as a ticket, not an incident.

### `ecs-web-running-low` / `ecs-worker-running-low`

**What it means.** The service has fewer than one running task. For
web, no pharmacist can type, verify, or ship. For worker, the
event-outbox drain, label rendering, notifications, and SLA timers all
stop while orders keep arriving — the queue damage keeps accruing
silently, and the SLA breaches land later as a storm.

Missing data counts as breaching for these alarms on purpose: a service
whose metric disappeared is not a service that is fine.

**First diagnostic step.**

```bash
aws ecs describe-services --cluster <prefix> --services <prefix>-web \
  --query 'services[0].{desired:desiredCount,running:runningCount,events:events[:5]}'
```

The `events` array names the reason — failed health checks, capacity,
or a task that will not boot. For a boot failure, read the stopped
task's `stoppedReason` and the last log lines from its log group. A
task that cannot reach Secrets Manager or KMS at boot fails
closed by design (see
[RUNBOOK § KMS boot validation failures](../RUNBOOK.md#kms-boot-validation-failures)).

**Escalation.** SEV1 for web. SEV1 for worker if it stays down more
than ~15 minutes; the outbox backlog and SLA timers are the reason the
clock matters, not the process itself. If a bad release is the cause,
the circuit breaker has probably already rolled the service back —
confirm the running image tag before assuming your rollback is what
fixed it.

**Follow-up.** After worker recovers, work
[RUNBOOK § Outbox drain stuck or backed up](../RUNBOOK.md#outbox-drain-stuck-or-backed-up)
and
[RUNBOOK § SLA breach storm](../RUNBOOK.md#sla-breach-storm--emergency-bucket-walkthrough).
Recovery of the process is not recovery of the work it missed.

**Not actually an emergency when.** You are mid-deploy and watching a
rolling replacement — but note the alarm needs two consecutive minutes
below one task, which a healthy rolling deploy does not produce. If
this alarm fires during a routine deploy, the deploy is not healthy.

### `audit-chain-integrity`

**What it means.** The nightly `verifyAuditChain` job found a break in
the hash chain of the audit log for at least one tenant. That is either
a bug corrupting the record of who did what to a prescription, or
someone editing that record directly.

**First diagnostic step.** Do not "fix" anything in the audit tables.
Identify the tenant and the first broken sequence number using
[RUNBOOK § Audit chain integrity check](../RUNBOOK.md#audit-chain-integrity-check),
and capture the output — it is evidence. Then check whether the signed
Merkle manifest for the affected day still verifies
([RUNBOOK § Verifying a Merkle manifest from S3](../RUNBOOK.md#verifying-a-merkle-manifest-from-s3));
manifests are held under Object Lock COMPLIANCE, so a chain break with
intact manifests bounds the damage to after the last signed root.

**Escalation.** SEV1, and it follows the security path in
[`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md) rather than the
availability path — the question "was this a bug or a person" has to be
answered by someone awake, and the answer determines whether this is a
HIPAA breach-assessment matter.

**Not actually an emergency when.** A restore drill or a migration
rewrote audit rows in a non-production database that is pointed at the
production metric namespace by mistake. Verify which database the
emitting job read before treating it as real — but verify it, do not
assume it.

### `outbox-stalled`

**What it means.** The oldest undispatched `event_outbox` row is more
than an hour old. The drainer has stopped making progress while
commands keep committing: shipping notifications, billing
materialization, label dispatch, and partner webhooks are all silently
queued. The console looks fine — that is the point of this alarm.

**First diagnostic step.** Is the worker running at all? (If
`ecs-worker-running-low` is also firing, that is the cause; fix that
one.) If the worker is up, follow
[RUNBOOK § Outbox drain stuck or backed up](../RUNBOOK.md#outbox-drain-stuck-or-backed-up):
look at the oldest PENDING/FAILED rows' `lastError` and `attempts` —
one poison row or one wedged downstream is the usual answer.

**Escalation.** Treat as an availability incident for everything
asynchronous. If it fired outside a deploy window, wake whoever owns
the failing handler's downstream.

**Not actually an emergency when.** A deliberate bulk backfill just
enqueued hours of work and depth is draining. Depth falling with age
high means the drainer is alive and chewing through the backlog — watch
it; don't restart it.

---

## Warning tier

These land in a mailbox or a ticket queue. They are read at shift
start. If one of them is genuinely urgent, the honest fix is to move
the alarm to the critical tier in Terraform — with its rationale — not
to teach people to watch the warning feed like a pager.

### `alb-target-p99`

**What it means.** The 99th-percentile response time from the web
target group has exceeded 2 seconds for fifteen minutes. One request in
a hundred is slow. The pharmacy is annoying to use; it is not stopped.

**First diagnostic step.** Trace one slow request end to end
([`../OBSERVABILITY.md`](../OBSERVABILITY.md) § Tracing one request);
in practice the answer is usually a single query without an index or a
third-party call without a tight timeout.

**Escalation.** Ticket. Escalate only if p99 keeps climbing or 5xx
starts rising with it.

**Not actually an emergency when.** A report export, a bulk import, or
a scan is generating a small number of intentionally slow requests.
Check whether the slow requests share one route before treating it as
systemic.

### `rds-cpu-high`

**What it means.** Writer CPU above 80% for ten minutes.

**First diagnostic step.** Performance Insights → top SQL by load. A
single dominant statement is a missing index or a query regression from
the last release; broad load across many statements is genuine growth.

**Escalation.** Ticket. It becomes an incident by way of the
connection or memory alarms, which page.

**Not actually an emergency when.** A migration, backfill, or
`ANALYZE` is running; or the CPU rise tracks a known traffic peak and
latency is unaffected.

### `rds-replica-lag`

**What it means.** The Aurora reader is more than 30 seconds behind the
writer. The reader backs `REPORTING_DATABASE_URL` only, so the
practical effect is stale reports — not failed dispensing.

**First diagnostic step.** Check whether the writer is also alarming.
Lag is usually a symptom of writer pressure, in which case the writer's
alarms are the real signal. If the writer is calm, look for a long
read query on the replica blocking apply.

**Escalation.** Ticket. Mention it to anyone acting on a report from
that window, because they may be looking at stale numbers.

**Not actually an emergency when.** A large batch write just landed
(bulk import, migration) and lag is already draining.

### `ecs-<svc>-cpu-high` / `ecs-<svc>-mem-high`

**What it means.** A service is running hot: CPU over 80% for fifteen
minutes, or memory over 85%.

**First diagnostic step.** For web, confirm autoscaling reacted
(`desiredCount` should have risen; min 3, max 20). For worker and
print-agent there is no autoscaling — check whether the load is a
backlog being worked off or a steady-state increase.

**Escalation.** Ticket, with a task-definition sizing change as the
remedy. Memory is the more urgent of the two: a task that exhausts its
memory is killed, which shows up on the paging availability alarm.

**Not actually an emergency when.** A deploy or a large outbox drain is
in progress; a short spike that self-resolves is the system working.

### `ecs-print-agent-running-low`

**What it means.** The print agent has no running task, so no vial
labels are printing. Dispensing stops on the floor — during business
hours. There is nothing useful for anyone to do about it at 03:00 in a
closed pharmacy, which is why it is a warning.

**First diagnostic step.** Confirm the service is meant to be running
at all (`desiredCount`), then read the stopped task's `stoppedReason`.
The agent resolves a specific workstation from the database at boot and
needs a network path to a physical Zebra printer; without both it
crash-loops.

**Escalation.** Ticket during the night; SEV2 during pharmacy hours,
because the floor cannot dispense. Reprints go through
[RUNBOOK § Resending a failed print job](../RUNBOOK.md#resending-a-failed-print-job)
— never by re-printing outside the command path, which is what makes a
reprint auditable.

**Known-absent state.** Production currently sets
`ecs_print_agent_desired_count = 0` (no physical pharmacy site yet), so
**this alarm does not exist in production today**. That is deliberate:
with `treat_missing_data = breaching` it would sit in ALARM
permanently, and a permanently-firing alarm teaches everyone to filter
the entire feed. When the agent is scaled up, raise
`ecs_print_agent_desired_count` in the env-region tfvars in the same
change — scaling with `aws ecs update-service` alone leaves the service
running unwatched, because the ECS service ignores `desired_count`
drift by design.

### `outbox-oldest-age-high`

**What it means.** The oldest undispatched `event_outbox` row is more
than fifteen minutes old. Some side effect — a notification, a billing
line, a webhook — is at least that late. Usually one failing handler
climbing its retry ladder, not a stalled drainer; the stall has its own
critical alarm at one hour.

**First diagnostic step.** Find the oldest PENDING/FAILED rows and read
`lastError` / `attempts` / `eventType`
([RUNBOOK § Outbox drain stuck or backed up](../RUNBOOK.md#outbox-drain-stuck-or-backed-up)).
One event type failing repeatedly is a downstream or handler bug; many
types aging together is early drainer trouble — treat it as the stall
alarm arriving early.

**Escalation.** Ticket. Escalate if age keeps climbing toward the
one-hour critical threshold or the affected event type is
shipping/billing-bearing.

**Not actually an emergency when.** A known downstream (Resend, a
partner webhook endpoint) is having an outage and rows are riding
backoff as designed. This alarm also fires on MISSING data, on
purpose: if the probe itself stops publishing, this is the tier that
notices — check the worker logs for `outbox.backlog.probe.failed`
before assuming a backlog exists.

### `outbox-dead-rows`

**What it means.** At least one `event_outbox` row is DEAD: it
exhausted all eight attempts and the drainer will never retry it. A
load-bearing side effect has been permanently missed. This alarm stays
in ALARM until the rows are dealt with — that is deliberate.

**First diagnostic step.** Read the DEAD rows' `eventType` and
`lastError`. The error text names the handler failure; the fix is
usually in the downstream or the handler, after which the row is
re-published through the admin replay path
([RUNBOOK § Outbox drain stuck or backed up](../RUNBOOK.md#outbox-drain-stuck-or-backed-up)).
Never mark a DEAD row DISPATCHED by hand — that erases the missed work
without performing it.

**Escalation.** Ticket, same morning. The longer a DEAD shipping or
billing event sits, the harder the operational cleanup on the other
side.

**Not actually an emergency when.** The rows are already known —
yesterday's incident, replay scheduled. It is never noise, though: a
DEAD row represents work the platform promised and did not do.

---

## No alert arrived at all

Work this list when an incident happened and nothing paged, or after
any change to the alerting stack. In order of how often each is the
answer:

1. **The subscription was never confirmed.** An email subscription
   sits in `PendingConfirmation` until a human clicks the AWS link, and
   a pending subscription receives nothing. `terraform apply`
   succeeding does not mean the pager works.

   ```bash
   aws sns list-subscriptions-by-topic --topic-arn <critical-topic-arn> \
     --query 'Subscriptions[].{Protocol:Protocol,Arn:SubscriptionArn}'
   ```

   A `SubscriptionArn` of `PendingConfirmation` is the smoking gun.

2. **There are no subscribers.** `terraform output
alerting_critical_subscription_count`. Zero means the topics exist
   and every page is delivered to nobody. The module emits a plan-time
   warning for this state, which is easy to scroll past.

3. **`enable_alerting` is false for this env-region.** Then the module
   never ran and the alarms have empty action lists — the original bug.
   `pnpm check:alarm-actions` fails the build for prod, so this should
   only ever be true in dev or staging.

4. **The KMS grant is broken.** The alerts CMK
   (`alias/<prefix>-alerts`) must allow
   `cloudwatch.amazonaws.com` to `kms:GenerateDataKey*` and
   `kms:Decrypt`. Without it, every publish fails and the alarm still
   looks perfectly healthy in the console. Check the key policy, and
   look for `KMSAccessDenied`-flavoured failures in the topic's
   delivery-failure metrics.

5. **The topic policy rejected the publish.** The policy accepts
   publishes only from alarms named `<prefix>-*` in this account. An
   alarm created outside the Terraform naming convention — by hand, in
   the console — will be refused.

6. **The alarm was in `INSUFFICIENT_DATA`, not `ALARM`.** Several
   alarms treat missing data as not-breaching, which is the right
   default for a metric that only appears under load and the wrong one
   for a metric that disappeared. `aws cloudwatch describe-alarms
--alarm-name-prefix <prefix>` shows the state history.

---

## Proving the pipe works

Do this after every change to the alerting stack, and once per quarter
regardless. It is the only way to know the path from alarm to human is
intact; an untested notification path is a hypothesis.

Announce it first — this delivers a real page to a real person.

```bash
# 1. Force one alarm into ALARM and confirm the notification arrives.
aws cloudwatch set-alarm-state \
  --alarm-name <prefix>-audit-chain-integrity \
  --state-value ALARM \
  --state-reason "alerting pipe test — <your name>, <ticket>"

# 2. Confirm receipt on the paging integration AND the backstop mailbox.

# 3. Return it to OK so the next real transition notifies again.
aws cloudwatch set-alarm-state \
  --alarm-name <prefix>-audit-chain-integrity \
  --state-value OK \
  --state-reason "alerting pipe test complete — <ticket>"
```

Repeat step 1 against any warning-tier alarm to test the second path;
the two topics have separate subscribers and separate failure modes.

Record the result wherever the quarterly control evidence lives. A
failed test is a SEV3 ticket at minimum: it means the next real
incident would have been silent.

---

## Changing who gets paged

Endpoints are **never** committed. Not in `terraform.tfvars`, not as a
variable default, not as an example in a comment: an on-call address is
personal data and a paging webhook URL is a bearer credential — anyone
holding it can inject fake pages.

They are supplied at apply time from the environment's secret store:

```bash
TF_VAR_alerting_critical_https_subscriptions='["https://<paging-provider-endpoint>"]' \
TF_VAR_alerting_critical_email_subscriptions='["<on-call-mailbox>"]' \
TF_VAR_alerting_warning_email_subscriptions='["<shift-mailbox>"]' \
  terraform plan -var-file=terraform.tfvars
```

In CI, those come from **repository-level** secrets named
`ALERTING_CRITICAL_EMAIL_SUBSCRIPTIONS`,
`ALERTING_WARNING_EMAIL_SUBSCRIPTIONS`,
`ALERTING_CRITICAL_HTTPS_SUBSCRIPTIONS`, and
`ALERTING_WARNING_HTTPS_SUBSCRIPTIONS` — each a JSON list, e.g.
`["oncall@example.com"]`. They are repo-level rather than
environment-scoped because the variables must be present at **plan**
time (the gated apply replays the saved plan binary and accepts no new
variables), and the plan job is intentionally ungated so the reviewer
sees the rendered plan before approving. The apply itself is still
reviewer-gated, which is why a subscription change is a
reviewer-approved apply and not a console edit. A console-added
subscription is drift: the nightly `terraform-drift` job plans with the
same secrets and will flag it, and the next apply will remove it.

To rotate a paging webhook, update the secret and re-apply; the old
subscription is destroyed and the new one created. Test with the
procedure above before you consider the rotation done.

---

## Related

- [`../RUNBOOK.md`](../RUNBOOK.md) — procedures for the failures these
  alarms detect.
- [`../OBSERVABILITY.md`](../OBSERVABILITY.md) — logs, Sentry, traces,
  audit chain.
- [`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md) — severity
  definitions, comms, breach assessment.
- [`../operations/production-deployment.md`](../operations/production-deployment.md)
  — the gated deploy and apply paths referenced above.
- [`../security/kms-key-inventory.md`](../security/kms-key-inventory.md)
  — the alerts CMK (#9).
- [`../../scripts/check-alarm-actions.ts`](../../scripts/check-alarm-actions.ts)
  — the CI guard that keeps every alarm wired to a tier.
