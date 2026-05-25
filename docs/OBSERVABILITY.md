# Observability

Where everything goes when something goes wrong, and how to find it.

## TL;DR

| Signal                        | Where it lives                                                              | How to query                      |
| ----------------------------- | --------------------------------------------------------------------------- | --------------------------------- |
| Application logs (structured) | `stdout` of each process → log aggregator (TBD per deploy)                  | `correlationId` filter            |
| Captured exceptions           | Sentry, project: `pharmacy-os` / `pharmacy-worker` / `pharmacy-print-agent` | `organization.id:<org-uuid>`      |
| Domain audit events           | `audit_log` table, hash-linked                                              | SQL on `audit_log.organizationId` |
| Workflow events               | `order_event` table                                                         | SQL on `order_event.orderId`      |
| Outbound side effects         | `event_outbox` table                                                        | SQL on outbox status / attempts   |
| Stripe webhook events         | `stripe_webhook_event` table                                                | SQL on `stripeEventId`            |
| EasyPost webhook events       | `easypost_webhook_event` table                                              | SQL on `easyPostEventId`          |
| Command execution             | `command_log` table                                                         | SQL on `commandLogId`             |
| SLA intervals                 | `order_stage_interval` table                                                | SQL on `(orderId, kind)`          |
| Idempotency replays           | `idempotency_key` table                                                     | SQL on `(organizationId, key)`    |

The first three layers (logs, Sentry, audit) are the ones an operator reaches for during an incident. The SQL tables are for forensic / compliance investigations.

## The four layers of observability

Pharmax is intentionally layered so that an incident on any one layer is recoverable from the others.

### Layer 1 — structured logs (every process, stdout)

Every process emits Pino-structured JSON to stdout, with:

- `level`: `debug` | `info` | `warn` | `error` (numeric per Pino, also `levelName` if you add it).
- `time`: ISO-8601.
- `service`: `pharmacy-os` | `pharmacy-worker` | `pharmacy-print-agent`.
- `message`: human-readable summary, never PHI.
- Structured fields: `correlationId`, `organizationId`, `siteId`, `orderId`, etc. (allowlist enforced by the Sentry scrubber — see [`apps/web/src/server/observability/sentry-scrubber.ts`](../apps/web/src/server/observability/sentry-scrubber.ts)).

PHI defense: Pino's `redact: { paths }` allowlist replaces sensitive fields with `[Redacted]` if they slip into a log context. See [`packages/platform-core/src/logger/redaction.ts`](../packages/platform-core/src/logger/redaction.ts).

**Tailing in dev:**

```bash
pnpm dev | pnpm dlx pino-pretty
```

**In prod:** ship `stdout` to your log aggregator (Loki, CloudWatch, Datadog Logs). The JSON shape is stable and the redaction list is exhaustive for known PHI fields.

### Layer 2 — Sentry (exceptions + alert-worthy logs)

Every `logger.error(...)` call automatically forwards to Sentry via the [ErrorReporter bridge](../packages/platform-core/src/logger/error-reporter.ts).

- If the context contains an `Error` instance under `error`, `cause`, or `err`, Sentry receives it as a captured exception (with stack).
- Otherwise Sentry receives a `captureMessage` at `error` level.
- The Sentry SDK is initialized in each app's `bootstrap()` / `main()` BEFORE any other init step, so uncaught exceptions and unhandled promise rejections also reach Sentry.

**PHI defense layers** (all required, all independent):

1. **Logger redactor** (Pino) scrubs the context before it reaches the bridge.
2. **ErrorReporter bridge** receives the already-scrubbed context.
3. **Sentry `beforeSend`** allowlist (server-side only) drops anything outside the known-safe key list.
4. **No `replaysSessionSampleRate` / `replaysOnErrorSampleRate`**: browser-side session replay is disabled because a frame could capture an on-screen patient name.

**Finding an error:** every server-side capture is tagged with `correlationId` (when present in the context). Search Sentry for that id and you'll see every related capture across all three apps.

**Alert routing:** configured in the Sentry project, not in code. Recommended:

- New-issue email/Slack for `level:error` events.
- High-volume threshold alert: > 10 of the same fingerprint in 5 min → page on-call.
- Audit-chain integrity alert: any event tagged `audit_chain.invalid` is automatic SEV1.

### Layer 3 — domain audit chain (`audit_log` table)

Every critical workflow transition writes an `audit_log` row inside the same transaction that mutates the order. The audit chain is hash-linked: `audit_log.hash` includes the prior row's hash, so any tamper attempt invalidates everything downstream.

- Schema: [`packages/audit/src/chain/writer.ts`](../packages/audit/src/chain/writer.ts) and [`/encoder.ts`](../packages/audit/src/chain/encoder.ts).
- Verification: `verifyAuditChain(organizationId)` walks the chain and returns the first break.
- Runtime check: nothing yet schedules `verifyAuditChain` — see [Runbook §"Audit chain integrity check"](RUNBOOK.md#audit-chain-integrity-check) for the manual recipe and [Implementation Plan](IMPLEMENTATION_PLAN.md) for the automated scheduler work item.

A chain break is by definition a SEV1 incident: it means either a bug allowed an out-of-band mutation, or someone wrote to the DB outside the command bus. Either way, it's a compliance event.

### Layer 4 — operational tables (forensic)

When the first three layers don't tell you what happened, query the underlying tables. The most useful ones during an incident:

| Question                                                | Table                  | Index to use                                    |
| ------------------------------------------------------- | ---------------------- | ----------------------------------------------- |
| What command actually ran for this idempotency key?     | `command_log`          | `(organizationId, commandName, idempotencyKey)` |
| Which orders are stuck in which state and for how long? | `order_stage_interval` | `(organizationId, orderId, kind)`               |
| Did the outbox drain a particular event?                | `event_outbox`         | `(status, leasedUntil)`                         |
| Did Stripe send us an event we never processed?         | `stripe_webhook_event` | `(status, receivedAt)`                          |
| Did the audit chain advance for this org?               | `audit_chain_state`    | `(organizationId)`                              |

All tenant tables have RLS + FORCE RLS. Always set the session GUC before querying:

```sql
SET LOCAL pharmax.organization_id = '<org-uuid>';
SET LOCAL pharmax.system_context = 'off';
```

For cross-tenant forensic queries (rare), use the `pharmax_system` role which has `system_context = 'on'`.

## Tracing one request end-to-end

1. **Get the `correlationId`** from the user / browser / failing API response. Every API route attaches it to the response (see `pharmax-error.ts`).
2. **Sentry**: search the project for `correlationId:<id>` to find any captured exception.
3. **Logs**: grep / filter the log aggregator for the same id. You'll see every `logger.*` call from web, worker, and print-agent that handled this work item.
4. **DB**: `command_log` has the `correlationId` column. Joining to `audit_log` / `order_event` / `event_outbox` gives the full causal chain.

## Adding a new metadata key to logs

When you add a new tenancy or domain id to a log context (e.g. `prescriptionId`):

1. Add the key to the **Sentry allowlist** in [`apps/web/src/server/observability/sentry-scrubber.ts`](../apps/web/src/server/observability/sentry-scrubber.ts) AND the inlined allowlists in [`apps/worker/src/observability/sentry-init.ts`](../apps/worker/src/observability/sentry-init.ts) and [`apps/print-agent/src/observability/sentry-init.ts`](../apps/print-agent/src/observability/sentry-init.ts).
2. Update [`sentry-scrubber.test.ts`](../apps/web/src/server/observability/sentry-scrubber.test.ts) with a case that exercises the new key.
3. If the new key could carry PHI, **add it to `redaction.ts` instead** and never log it directly.

## What we deliberately don't track

Per [`.cursor/rules/03-sla-performance.mdc`](../.cursor/rules/03-sla-performance.mdc), application-level activity only:

- Login / logout / heartbeat.
- Order opened, queue claimed, command started/completed, scan, print.
- Idle started / ended.

We do **not** track screenshots, keystrokes, websites visited, or personal device activity. That bar is non-negotiable.
