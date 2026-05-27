# 0014 — Stripe ports + adapters; the domain `@pharmax/billing` package stays SDK-free

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** billing, integrations, architecture

## Context

Billing depends on Stripe in three places: **push** (finalized
invoices and line items go to Stripe so customers can be charged),
**refunds** (`stripe.refunds.create` against a captured
`stripeChargeId`), and **reconciliation** (`invoice.paid`,
`invoice.voided`, `invoice.marked_uncollectible`,
`invoice.payment_failed`, `charge.refunded` webhooks flip status and
record amounts).

The Stripe TypeScript SDK is large, ships typings that move across
versions, and pulls in fetch/timeout/retry concerns we do not want
inside the domain. The domain logic (idempotency keys, status
guards, CAS on `Invoice.version`, audit + outbox writes) is the part
that is hard, valuable, and testable without Stripe.

Two anti-patterns to avoid: Stripe SDK imported directly inside
`@pharmax/billing` (couples domain to vendor versions); webhook
handlers that contain domain logic inline (loses reuse between the
synchronous refund path on web and the async reconciliation path on
worker).

## Decision

Apply **ports and adapters** (hexagonal architecture) to the Stripe
boundary. The domain `@pharmax/billing` package is **SDK-free**.

**Ports (interfaces) live in `@pharmax/billing`:**

- `StripeInvoicePort` — `createInvoiceItem`, `createInvoice`,
  `finalizeInvoice`, each accepting Pharmax-shaped inputs and
  returning narrow result types.
- `StripeRefundPort` — `createRefund` with a `pharmaxRefundKey` that
  doubles as Stripe's idempotency key so retries converge.
- `configureBilling({ stripeInvoicePort?, stripeRefundPort? })` is
  the boot-time wire-up. Calling a domain command before the relevant
  port is configured throws `InternalError(BILLING_PORT_NOT_CONFIGURED)`
  — a missed wire kills the call, not silently no-ops.

**Adapters live in the runtime tiers, not in `@pharmax/billing`:**

- `apps/worker/src/billing/stripe-invoice-adapter.ts` wraps
  `stripe.invoiceItems.create` + `stripe.invoices.create` +
  `stripe.invoices.finalizeInvoice`, with `pharmax-line:{id}` and
  `pharmax-invoice:{id}` idempotency keys so retries are safe.
- `apps/worker/src/billing/stripe-refund-adapter.ts` and
  `apps/web/src/server/billing/stripe-refund-port.ts` — one adapter
  per runtime tier because `IssueRefund` runs synchronously on the
  web tier (operator click → Stripe round-trip → response), while
  `RecordRefundReceived` runs on the worker after the webhook drain.
- Adapter errors are translated to typed domain codes:
  `STRIPE_REFUND_CHARGE_NOT_REFUNDABLE` for `charge_already_refunded`
  / `charge_disputed`; `STRIPE_REFUND_API_ERROR` for everything else;
  same translation pattern for the invoice port.

**Commands live in `@pharmax/billing`:**

- `FinalizeInvoice` (tenant), `MarkInvoicePaid` /
  `MarkInvoiceVoided` / `MarkInvoiceUncollectible` /
  `RecordInvoicePaymentFailure` / `RecordStripeInvoicePushed` /
  `RecordRefundReceived` (system, idempotent at the bus layer on
  `stripe-event:{eventId}`), `IssueRefund` (tenant), and the
  shipped-order materialization `MaterializeShippedOrderBilling`
  (system). All flow through the standard command bus (ADR 0007)
  with CAS on `Invoice.version` and orphan tolerance on Stripe
  events for invoices we cannot resolve.

**Webhook routing lives in `apps/worker/src/drains/stripe-handlers.ts`:**

- `createStripeEventHandlers(prisma)` factory maps Stripe event types
  to commands. Each handler resolves the Pharmax invoice via
  `prisma.invoice.findUnique({where: {stripeInvoiceId}})` in system
  context, then dispatches the command in another system-context
  frame for the audit trail.

## Consequences

**Easier:**

- Stripe SDK upgrades touch only the adapters, never the domain.
- Domain tests inject deterministic stub ports; no Stripe mock
  needed in `@pharmax/billing`.
- Adding a second payment processor (Adyen, GoCardless) is one new
  pair of adapters; the domain commands stay unchanged.

**Harder:**

- Two-tier deployments must wire both adapters (web for synchronous
  refund, worker for async reconciliation). Forgetting one surfaces
  as a typed error at first dispatch — failure mode is loud.
- The port interfaces are small and stable, but evolving them
  requires coordinated changes across the domain and both adapters.

**Ongoing obligations:**

- New Stripe event types route through the handlers factory, not
  directly into the domain.
- The optional `STRIPE_SECRET_KEY` env: when unset the push handler
  logs and no-ops so dev environments aren't forced into Stripe
  wiring.
- ESLint boundary rule: `stripe` (the SDK) is not importable from
  `@pharmax/billing` source files.

## Alternatives Considered

- **Stripe SDK directly inside `@pharmax/billing`.** Tight coupling,
  test pain, version churn radiating outward.
- **Webhook handlers as the domain layer.** Loses reuse between
  synchronous and asynchronous paths; reintroduces "twelve almost
  correct" implementations.
- **One omnibus billing service.** Reintroduces microservices we
  already declined (ADR 0002).

## References

- ADR 0002 — Modular monolith with event-driven internals
- ADR 0007 — Twenty-step command-bus contract
- ADR 0009 — Outbox pattern (Stripe webhooks land in
  `stripe_webhook_event` inbox; drained by worker)
- `packages/billing/src/ports/` — `StripeInvoicePort`, `StripeRefundPort`
- `apps/worker/src/billing/` — adapter wiring
- `apps/worker/src/drains/stripe-handlers.ts` — event routing
- `docs/BILLING.md`
