# Billing module

Billing is its own domain. It is driven by **operational truth** (e.g. an
order is shipped → a billing event is emitted → an invoice line is written
→ Stripe is updated). Stripe is the payment processor; it is **not** the
source of truth for invoices.

## Current scope (phase 0)

Implemented in `@pharmax/platform-core/billing`:

- Stripe webhook signature verifier (wraps `constructEventAsync`).
- `stripe_webhook_event` ledger contract (idempotency + audit).
- Event dispatcher with an explicit allowlist of supported event types.
- Transport-agnostic `handleStripeWebhook(input, deps)` entry point.
- Two worker entry points:
  - `processStripeWebhookEvent(stripeEventId, deps)` — looks up the
    row, marks it PROCESSING, dispatches, marks the outcome. Use for
    admin "retry this event" actions and tests.
  - `executeStripeWebhookEventDispatch(record, deps)` — dispatches an
    ALREADY-claimed record and marks the outcome. Use from the
    production worker drainer, which has done the markProcessing
    equivalent atomically via `UPDATE … FROM (SELECT … FOR UPDATE
SKIP LOCKED)`. Calling `markProcessing` again would double-
    increment `attempts`.
- In-memory `StripeWebhookEventStore` (test fixture only).
- Prisma-backed `StripeWebhookEventStore` in
  `@pharmax/database` (`billing.PrismaStripeWebhookEventStore`) —
  production implementation. Idempotent inserts via
  `INSERT ... ON CONFLICT DO NOTHING` semantics (Prisma `create` +
  `P2002` catch-and-refetch).

Implemented in `apps/web` (phase 1):

- `/api/webhooks/stripe` POST route. Returns 503 with a clear payload
  when Stripe env vars are absent, so the app boots in environments
  without Stripe credentials.

Implemented in `apps/worker` (phase 1):

- `stripe-webhook-event-drainer` — atomic claim + dispatch + mark loop.
- Generic `event-outbox-drainer` — same pattern for the domain outbox.
- `poll-loop` runtime with graceful SIGINT/SIGTERM shutdown that waits
  for any in-flight tick before disconnecting Prisma and exiting.

Deferred:

- Outbound integration: turning operational billing events into Stripe
  invoices (this is the **other** direction of the integration; the
  webhook handler in this module only handles inbound Stripe → Pharmax).
- BullMQ-backed queues. The transactional outbox pattern is correctly
  implemented as DB polling because the source of truth is the table
  itself; BullMQ is reserved for true queue-driven jobs (label render,
  email send, downstream HTTP fan-out) that show up in later phases.

## Why split webhook handling into transport + worker?

Stripe expects a 2xx within a few seconds. Domain processing (looking up
the tenant, writing invoice lines, calling the outbox) can take longer
than that, especially on first request or after a deploy. The split here
mirrors the rest of the platform:

- The **transport handler** verifies the signature and persists the event
  row atomically. Acks 200 on accepted / duplicate / ignored.
- The **worker** transitions the row through `PROCESSING → SUCCEEDED |
FAILED`. Idempotent. Retries with exponential backoff up to a cap.

Replays from Stripe land in the same persisted row (idempotency by
`stripeEventId`), so no domain side effect can run twice.

## Wiring guide (when phase-1 apps land)

### 1. Configure Stripe and the verifier

Server-only env vars (already declared in `.env.example`):

```bash
STRIPE_SECRET_KEY="sk_test_…"
STRIPE_WEBHOOK_SECRET="whsec_…"
```

`STRIPE_WEBHOOK_SECRET` **must not** be exposed via `NEXT_PUBLIC_*`.

```ts
import Stripe from "stripe";
import { billing } from "@pharmax/platform-core";

const stripe = new Stripe(process.env["STRIPE_SECRET_KEY"]!, {
  apiVersion: "2024-06-20",
});
const verifier = billing.createStripeWebhookSignatureVerifier(stripe);
```

### 2. Construct the Prisma-backed event store

```ts
// apps/web/src/server/billing/stripe-webhook-event-store.ts (NOT YET CREATED)
import { prisma, billing as dbBilling } from "@pharmax/database";

export const stripeWebhookEventStore = new dbBilling.PrismaStripeWebhookEventStore(prisma);
```

`PrismaStripeWebhookEventStore` accepts any structurally-compatible
client (the `StripeWebhookEventClient` interface). In production, pass
the singleton `prisma`. In tests, pass a fake delegate — that is how
the package's own unit tests exercise every branch without a database.

### 3. Mount the Next.js route handler

```ts
// apps/web/app/api/webhooks/stripe/route.ts (NOT YET CREATED)
import { billing } from "@pharmax/platform-core";

import { logger } from "@/server/logger";
import { stripeWebhookEventStore } from "@/server/billing/stripe-webhook-event-store";
import { stripe } from "@/server/billing/stripe-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const verifier = billing.createStripeWebhookSignatureVerifier(stripe);

export async function POST(request: Request): Promise<Response> {
  const signatureHeader = request.headers.get("stripe-signature");
  const rawBody = await request.text(); // raw — DO NOT parse JSON first

  const result = await billing.handleStripeWebhook(
    { rawBody, signatureHeader },
    {
      verifier,
      eventStore: stripeWebhookEventStore,
      webhookSecret: process.env["STRIPE_WEBHOOK_SECRET"]!,
      logger,
    }
  );

  // 200 on accepted / duplicate / ignored. 400 on missing/invalid signature.
  return new Response(null, { status: result.httpStatus });
}
```

Key points:

- `runtime = "nodejs"` so the raw body is delivered intact (`stripe`
  signature verification will not work on the Edge runtime without the
  async crypto path — `constructEventAsync` does support both).
- Use `request.text()`, never `request.json()`. Any reformat invalidates
  the signature.
- Never `console.log(rawBody)` or `console.log(signatureHeader)` — both
  count as PHI-adjacent secrets in audit. Use the structured logger.

### 4. Register domain handlers

Domain handlers live close to the billing service, not in `platform-core`:

```ts
// apps/web/src/server/billing/handlers.ts (NOT YET CREATED)
import type { billing } from "@pharmax/platform-core";

export const stripeHandlers: Record<string, billing.StripeEventHandler> = {
  "invoice.paid": async (event, ctx) => {
    // Resolve clinic via StripeCustomer mapping, then call
    // MarkInvoicePaid command. Command handler is responsible for
    // command_log + order_event + audit_log + event_outbox writes.
  },
  "invoice.payment_failed": async (event, ctx) => {
    // …
  },
};

export const dispatcher = billing.createStripeWebhookEventDispatcher({
  handlers: stripeHandlers,
});
```

### 5. Run the worker

`apps/worker` boots two long-lived poll loops on start. The Stripe drain
loop calls `claimStripeWebhookEvents` (a single atomic UPDATE — see
`apps/worker/src/drains/claim-stripe-webhook-events.ts`) and then runs
each claimed row through `executeStripeWebhookEventDispatch`. To
register handlers for production processing, edit
`apps/worker/src/drains/stripe-handlers.ts`:

```ts
// apps/worker/src/drains/stripe-handlers.ts
import type { billing } from "@pharmax/platform-core";

type HandlerMap = billing.CreateDispatcherInput["handlers"];

export const stripeEventHandlers: HandlerMap = {
  "invoice.paid": async (event, ctx) => {
    // Resolve clinic via StripeCustomer mapping, then call
    // MarkInvoicePaid command. The command handler is responsible
    // for command_log + order_event + audit_log + event_outbox writes.
  },
};
```

The atomic claim query (the canonical pattern; lives at
`apps/worker/src/drains/claim-stripe-webhook-events.ts`):

```sql
UPDATE stripe_webhook_event
SET    status = 'PROCESSING',
       processing_started_at = NOW(),
       attempts = attempts + 1,
       next_attempt_at = NOW() + ($lease || ' milliseconds')::interval
WHERE  id IN (
  SELECT id FROM stripe_webhook_event
  WHERE status IN ('PENDING','FAILED')
    AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
  ORDER BY received_at
  LIMIT $batch
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

Run the worker locally with `pnpm worker:dev` (tsx watch) or
`pnpm worker:start` (single tsx run).

## Local development

```bash
# 1. Forward Stripe test webhooks to the local Next.js app.
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# 2. Trigger synthetic events.
stripe trigger invoice.paid
stripe trigger invoice.payment_failed
```

**Never use real Stripe customer data, real patient data, or production
keys with this setup.** Use Stripe test-mode keys only. The
`stripe trigger` payloads are synthetic.

## Security and compliance checklist

- [x] Signature verification on every inbound webhook.
- [x] Idempotency by `stripeEventId` enforced at the ledger row level.
- [x] Raw bodies and signatures never logged.
- [x] Webhook secret is server-only; never exposed via `NEXT_PUBLIC_*`.
- [x] Explicit allowlist of supported event types; unknown types are
      recorded but not dispatched.
- [x] Worker errors are sanitized before persistence (`name: message`
      only) — no payload echoing.
- [ ] Domain handlers resolve tenancy (organization + clinic) before
      writing invoice lines. **Enforced in the command handlers added in
      phase 1.**
- [ ] Audit log + event outbox writes for every state transition.
      **Enforced in the command handlers added in phase 1.**
