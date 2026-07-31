# Chaos Drills

Deliberate, scheduled failure injection in **staging** to prove the
system degrades the way the design says it does: failures are loud,
queues back up without data loss, and recovery is automatic once the
fault clears. Three scenarios, one per quarter on rotation, so every
scenario runs at least once a year:

1. [Printer outage](#drill-a--printer-outage) — a Zebra becomes
   unreachable mid-shift.
2. [Queue backpressure](#drill-b--queue-backpressure) — the worker
   stalls while commands keep committing.
3. [Stripe outage](#drill-c--stripe-outage) — invoice finalization
   during a payment-provider outage.

Evidence tooling: `scripts/operations/run-chaos-drill.ts` (see
[Evidence](#evidence)). Companion drills: the quarterly Aurora
restore drill ([restore-drill.md](./restore-drill.md)) covers the
data-loss axis; chaos drills cover the availability/degradation axis.

## Ground rules

- **Staging only. Never production.** The snapshot tool and every
  procedure below assume the staging stack; a chaos drill against
  production is an incident, not a drill.
- **Two people.** A captain (runs the drill) and an observer (watches
  dashboards/logs, keeps time, records findings). Same roles as the
  restore drill.
- **Announce it.** Post in the engineering channel before injection
  and after recovery so nobody burns an afternoon debugging staged
  breakage — and so Sentry/alert noise during the window is
  attributable.
- **Time-box it.** Each drill is designed to finish inside 90
  minutes including evidence capture. Abort criteria are listed per
  scenario; aborting is a finding, not a failure of the drill.
- **Findings get owners.** Every FAIL against the success criteria
  and every surprise becomes either a remediation ticket or a
  risk-register entry before the drill is signed off.

## Drill A — Printer outage

**Hypothesis.** A dead printer fails loudly: every affected print
job ends `FAILED` with a captured reason, no phantom vial label is
ever recorded (`No silent printer failures` / a successful record
requires physical output), and printing resumes without manual queue
surgery once the printer returns.

**What actually happens in the code** (what you are verifying):
`PrintVialLabel` creates a `print_job` row (PENDING) inside the
command transaction → the worker dispatch drain marks it SENT → the
print-agent claims it with a 60s lease
(`apps/print-agent/src/claim-sent-print-job.ts`), attempts the raw
TCP send, and on failure runs `ConfirmVialLabelPrint` with status
FAILED and a sanitized failure reason
(`apps/print-agent/src/process-sent-print-job.ts`). An agent crash
mid-job lets the lease expire so the job is reclaimable.

**Injection.** Pick the staging workstation's `LabelPrinter` row and
repoint its host to a blackhole address (e.g. `10.255.255.1:9100`),
or firewall the real staging Zebra bridge. Do NOT stop the
print-agent — the point is a healthy agent facing a dead printer.

**Procedure.**

1. `pnpm chaos:snapshot -- --scenario=printer-outage --label=baseline`
2. Inject the fault. Note the exact change (for `--injection=` later).
3. Print 3–5 vial labels through the normal fill workflow on the
   staging workstation.
4. Observe: each job should go SENT → FAILED within the transport
   timeout + confirm retries. Capture
   `pnpm chaos:snapshot -- --scenario=printer-outage --label=during`.
5. Kill the print-agent process mid-job once (while a job is leased)
   and restart it: the leased job must be reclaimed after lease
   expiry, not stuck.
6. Clear the fault. Reprint one of the failed labels — the reprint
   command requires a reason code; use `PRINTER_FAILURE`.
7. `pnpm chaos:snapshot -- --scenario=printer-outage --label=recovery`

**Success criteria** (each becomes a `--check=` on finalize):

- Every affected job is `FAILED` with a non-empty `failureReason`;
  zero jobs `COMPLETED` while the printer was dark.
- No job stuck `SENT` with an expired lease after the agent restart.
- The order timeline / print history shows the failures (operator-visible,
  not just DB state).
- Reprint after recovery required a reason code and produced a
  physical(-equivalent) label.
- `print-agent.zpl.failed` log lines and the print-agent Sentry
  captures carry ids only — no ZPL bodies, no patient data.

**Abort criteria.** Any job reaching `COMPLETED` during the outage —
stop immediately, that is a phantom-label bug (SEV1-shaped finding).

## Drill B — Queue backpressure

**Hypothesis.** With the worker stopped, committed commands keep
succeeding while `event_outbox` backlog grows; nothing is lost; on
worker restart the drainer clears the backlog in claim order without
duplicate side effects, and rows never silently disappear.

**What actually happens in the code:** every critical command writes
outbox rows in-transaction (`createOutboxEventsInTx`); the drainer
claims batches `FOR UPDATE SKIP LOCKED` with a lease, retries with
exponential backoff (30s → 64m over 8 attempts), and completion
writes are fenced on the claim's `attempts` token
(`apps/worker/src/drains/event-outbox-drainer.ts`). The
`pharmax_outbox_claim_lag_seconds` histogram measures commit→claim
wall time.

**Injection.** Scale the staging worker service to zero (ECS
`desired-count 0`, or kill the local worker process). Leave web up.

**Procedure.**

1. `pnpm chaos:snapshot -- --scenario=queue-backpressure --label=baseline`
2. Stop the worker. Note the timestamp.
3. Generate load: run normal staging workflow activity (or the seed
   script's workflow section) so a few hundred outbox rows accrue.
4. `pnpm chaos:snapshot -- --scenario=queue-backpressure --label=during`
   — `event_outbox` PENDING should be climbing;
   `oldestNonTerminalAgeSeconds` grows linearly.
5. Verify web stayed healthy: commands still succeed (the outbox
   decouples them from the worker by design).
6. Restart the worker. Time the drain: watch PENDING fall and the
   claim-lag histogram spike then recover.
7. `pnpm chaos:snapshot -- --scenario=queue-backpressure --label=recovery`

**Success criteria:**

- Zero command failures in web attributable to the stopped worker.
- Backlog drained to baseline within 15 minutes of restart (tune the
  expectation to the injected volume; record actual).
- Zero rows `DEAD` as a result of the drill; zero rows vanished
  (PENDING + DISPATCHED accounting matches what was generated).
- No duplicated side effects after restart (spot-check one
  fanned-out webhook delivery and one billing event — the fence +
  `skipDuplicates` idempotency should hold).
- Claim-lag histogram shows the backlog window and recovery.

**Abort criteria.** Web-tier command failures caused by the stopped
worker (coupling that shouldn't exist), or backlog still not
draining 30 minutes after restart.

## Drill C — Stripe outage

**Hypothesis.** Invoice finalization during a Stripe outage never
blocks the operator, never silently drops a push, and self-heals:
push rows ride the retry/backoff path while Stripe is down and
converge (idempotently) once it returns.

**What actually happens in the code:** `FinalizeInvoice` emits
`billing.invoice.finalized.v1` through the outbox rather than
calling Stripe inline; the worker handler pushes with idempotency
key `pharmax-invoice:{id}` and **fails the row loudly** when Stripe
is unconfigured/unreachable (retry/backoff → DEAD after 8 attempts,
roughly 2 hours — see
`apps/worker/src/drains/push-invoice-to-stripe.ts`).

**Injection.** In the staging worker environment, replace
`STRIPE_SECRET_KEY` with a syntactically valid but revoked/bogus key
(exercises the SDK-error path), or unset it (exercises the
not-configured path). Restart the worker to pick it up.

**Procedure.**

1. `pnpm chaos:snapshot -- --scenario=stripe-outage --label=baseline`
2. Inject the fault and restart the worker.
3. Finalize 2–3 staging invoices through the normal billing flow.
   The finalize commands must succeed immediately (operator UX
   unaffected).
4. `pnpm chaos:snapshot -- --scenario=stripe-outage --label=during`
   — the `billing.invoice.finalized.v1` rows should be `FAILED` with
   backoff timestamps, `lastError` naming the Stripe failure, and
   the `pharmax_billing_stripe_push_total` counter incrementing with
   a failure outcome.
5. **Before attempt 8** (stay inside ~1 hour to keep margin),
   restore the real key and restart the worker.
6. Wait out the current backoff (or use the republish tooling —
   `scripts/operations/republish-dead-outbox.ts` — if any row went
   DEAD). Verify each invoice reaches Stripe exactly once
   (`stripeInvoiceId` set; no duplicate Stripe invoices).
7. `pnpm chaos:snapshot -- --scenario=stripe-outage --label=recovery`

**Success criteria:**

- Finalize commands succeeded during the outage with normal latency.
- Zero push rows marked DISPATCHED while Stripe was down (no silent
  success).
- After recovery every invoice has exactly one Stripe invoice
  (idempotency held across retries).
- Any DEAD row was recoverable via the republish path.
- Logs/Sentry captures carry invoice/outbox ids only.

**Abort criteria.** A push row marked DISPATCHED during the outage
(silent drop — SEV1-shaped finding), or operator-facing finalize
failures.

## Evidence

Every drill produces a folder
`evidence/chaos-drills/<period>/<date>-<scenario>/` containing the
labeled queue snapshots plus `evidence.md` / `evidence.json`:

```bash
# During the drill (staging DATABASE_URL with the system role):
pnpm chaos:snapshot -- --scenario=<scenario> --label=<baseline|during|recovery>

# After recovery:
pnpm chaos:finalize -- --scenario=<scenario> \
  --captain="…" --observer="…" \
  --hypothesis="…" --injection="…" --recovery="…" \
  --check="PASS: …" --check="FAIL: …" \
  --findings="…" --sign-off="…"
```

Upload the folder to the SOC 2 evidence repository under
`availability/chaos-drills/<period>/`. Mapping: **CC7.4** (incident
response procedures exercised), **A1.2** (recovery/resilience
mechanisms tested). Findings that represent accepted risk go to the
[risk register](../governance/risk-register.md); everything else
gets a remediation ticket linked from the evidence markdown.

## Cadence

One drill per quarter, scenarios on rotation (A → B → C → A …), plus
a rerun of any scenario whose previous execution had a FAIL check.
The quarterly compliance review (see
[evidence-collection-guide.md](../compliance/evidence-collection-guide.md))
checks that the current quarter's folder exists.
