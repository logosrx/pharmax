// Stripe webhook event handlers (worker side).
//
// The Stripe webhook drain (`apps/worker/src/drains/stripe-webhook-event-drainer.ts`)
// claims rows from the `stripe_webhook_event` inbox, then calls the
// dispatcher built from this handler map. Each handler:
//
//   1. Extracts the relevant Stripe id (`invoice.id`) from the
//      event payload.
//   2. Resolves the Pharmax invoice + organizationId in SYSTEM
//      context (the webhook is tenant-less by definition; this is
//      one of the legitimate uses of `withSystemContext` — same
//      bridge pattern as the EasyPost / shipping target resolvers,
//      eslint Override 3b allowlists `apps/worker/src/drains/**`).
//   3. Dispatches the matching `@pharmax/billing` SystemCommand
//      with `idempotencyKey = stripe-event:{eventId}` so the bus
//      short-circuits Stripe redelivery before hitting the DB.
//
// EONPRO-grade durability semantics (see EONPRO
// `wellmedr/webhooks/stripe/route.ts` for the reference shape):
//
//   - At-most-once dispatch via the `stripe_webhook_event` table's
//     `externalEventId` unique index (writer side, already shipped).
//   - Bus-level idempotency keyed on the Stripe event id makes
//     manual replays safe.
//   - Per-command "already in target status" short-circuit is the
//     row-level second line of defense.
//   - Orphan events (Stripe invoice not linked to any Pharmax
//     invoice) return cleanly with `recognized: false`; the drain
//     marks the row SUCCEEDED. Stripe will NOT keep retrying.
//   - All other failures bubble — the drain's retry/backoff policy
//     handles transient infra issues.
//
// Unhandled event types (`customer.*`, `payment_intent.*`,
// `charge.refunded`, etc.) log + no-op for now. Those land in the
// notification + refund slices.
//
// PHI invariant: no PHI is read or written. Stripe payloads contain
// customer email + address (operator-facing, not PHI by convention),
// but we project only ids + amounts + timestamps onto the command
// surface.

import { executeSystemCommand } from "@pharmax/command-bus";
import {
  MarkInvoicePaid,
  MarkInvoiceUncollectible,
  MarkInvoiceVoided,
  RecordInvoicePaymentFailure,
  RecordRefundReceived,
} from "@pharmax/billing";
import type { PrismaClient } from "@pharmax/database";
import type { billing, logger as loggerContract } from "@pharmax/platform-core";
import { errors } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";
import type Stripe from "stripe";

type Logger = loggerContract.Logger;
type HandlerMap = billing.CreateDispatcherInput["handlers"];

export interface CreateStripeEventHandlersOptions {
  /** Full Prisma client for the system-context invoice lookup. */
  readonly client: PrismaClient;
}

/**
 * Resolve a Stripe invoice id → `(pharmaxInvoiceId, organizationId)`.
 * Returns `null` for orphan events (Stripe invoice not in our DB).
 */
async function resolvePharmaxInvoice(
  client: PrismaClient,
  stripeInvoiceId: string
): Promise<{ invoiceId: string; organizationId: string } | null> {
  return withSystemContext("worker-drain:stripe-invoice-resolve", async () => {
    const row = await client.invoice.findUnique({
      where: { stripeInvoiceId },
      select: { id: true, organizationId: true },
    });
    if (row === null) {
      return null;
    }
    return { invoiceId: row.id, organizationId: row.organizationId };
  });
}

/**
 * Stripe SDK v22+ types omit `subscription` on Invoice. Runtime
 * payloads (for subscription-driven invoices) still include it.
 */
function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const sub = (invoice as unknown as { subscription?: string | Stripe.Subscription | null })
    .subscription;
  return typeof sub === "string" ? sub : sub?.id;
}

/**
 * Stripe `latest_charge` may be string or expanded object depending
 * on retrieval mode. The webhook payload generally has the id as a
 * string but we handle both shapes.
 */
function getLatestChargeId(invoice: Stripe.Invoice): string | undefined {
  const charge = (invoice as unknown as { charge?: string | Stripe.Charge | null }).charge;
  if (typeof charge === "string" && charge.length > 0) return charge;
  if (charge && typeof charge === "object" && "id" in charge && typeof charge.id === "string") {
    return charge.id;
  }
  return undefined;
}

function requireStripeInvoiceId(event: Stripe.Event): { id: string; invoice: Stripe.Invoice } {
  const invoice = event.data.object as Stripe.Invoice;
  if (typeof invoice.id !== "string" || invoice.id.length === 0) {
    throw new errors.InternalError({
      code: "STRIPE_HANDLER_INVOICE_ID_MISSING",
      message: `${event.type} event has no invoice.id; refusing to dispatch.`,
      metadata: { stripeEventId: event.id, eventType: event.type },
    });
  }
  return { id: invoice.id, invoice };
}

export function createStripeEventHandlers(options: CreateStripeEventHandlersOptions): HandlerMap {
  const { client } = options;

  const handleInvoicePaid = async (
    event: Stripe.Event,
    ctx: { logger: Logger; receivedAt: Date }
  ): Promise<void> => {
    const { id: stripeInvoiceId, invoice } = requireStripeInvoiceId(event);
    const target = await resolvePharmaxInvoice(client, stripeInvoiceId);
    if (target === null) {
      ctx.logger.info("stripe.invoice.paid.orphan", {
        stripeEventId: event.id,
        stripeInvoiceId,
        reason: "no-matching-pharmax-invoice",
      });
      return;
    }

    // Stripe's `status_transitions.paid_at` is the authoritative
    // payment timestamp; fall back to event creation time if absent
    // (shouldn't happen for `invoice.paid` but defensive).
    const paidAtUnix =
      invoice.status_transitions?.paid_at ?? Math.floor(event.created ?? Date.now() / 1000);

    const result = await withSystemContext("worker-drain:stripe-invoice-paid", async () =>
      executeSystemCommand(
        MarkInvoicePaid,
        {
          invoiceId: target.invoiceId,
          organizationId: target.organizationId,
          stripeInvoiceId,
          amountPaidCents: invoice.amount_paid ?? 0,
          paidAt: new Date(paidAtUnix * 1000).toISOString(),
          stripeEventId: event.id,
          ...(getLatestChargeId(invoice) !== undefined
            ? { stripeChargeId: getLatestChargeId(invoice)! }
            : {}),
        },
        { idempotencyKey: `stripe-event:${event.id}` }
      )
    );

    ctx.logger.info("stripe.invoice.paid.applied", {
      stripeEventId: event.id,
      stripeInvoiceId,
      pharmaxInvoiceId: target.invoiceId,
      transitioned: result.transitioned,
      amountPaidCents: result.amountPaidCents,
      subscriptionId: getInvoiceSubscriptionId(invoice) ?? null,
    });
  };

  const handleInvoiceVoided = async (
    event: Stripe.Event,
    ctx: { logger: Logger; receivedAt: Date }
  ): Promise<void> => {
    const { id: stripeInvoiceId, invoice } = requireStripeInvoiceId(event);
    const target = await resolvePharmaxInvoice(client, stripeInvoiceId);
    if (target === null) {
      ctx.logger.info("stripe.invoice.voided.orphan", {
        stripeEventId: event.id,
        stripeInvoiceId,
      });
      return;
    }

    const voidedAtUnix =
      invoice.status_transitions?.voided_at ?? Math.floor(event.created ?? Date.now() / 1000);

    const result = await withSystemContext("worker-drain:stripe-invoice-voided", async () =>
      executeSystemCommand(
        MarkInvoiceVoided,
        {
          invoiceId: target.invoiceId,
          organizationId: target.organizationId,
          stripeInvoiceId,
          voidedAt: new Date(voidedAtUnix * 1000).toISOString(),
          stripeEventId: event.id,
        },
        { idempotencyKey: `stripe-event:${event.id}` }
      )
    );

    ctx.logger.info("stripe.invoice.voided.applied", {
      stripeEventId: event.id,
      stripeInvoiceId,
      pharmaxInvoiceId: target.invoiceId,
      transitioned: result.transitioned,
    });
  };

  const handleInvoiceUncollectible = async (
    event: Stripe.Event,
    ctx: { logger: Logger; receivedAt: Date }
  ): Promise<void> => {
    const { id: stripeInvoiceId, invoice } = requireStripeInvoiceId(event);
    const target = await resolvePharmaxInvoice(client, stripeInvoiceId);
    if (target === null) {
      ctx.logger.info("stripe.invoice.uncollectible.orphan", {
        stripeEventId: event.id,
        stripeInvoiceId,
      });
      return;
    }

    const recordedAtUnix =
      invoice.status_transitions?.marked_uncollectible_at ??
      Math.floor(event.created ?? Date.now() / 1000);

    const result = await withSystemContext("worker-drain:stripe-invoice-uncollectible", async () =>
      executeSystemCommand(
        MarkInvoiceUncollectible,
        {
          invoiceId: target.invoiceId,
          organizationId: target.organizationId,
          stripeInvoiceId,
          recordedAt: new Date(recordedAtUnix * 1000).toISOString(),
          stripeEventId: event.id,
        },
        { idempotencyKey: `stripe-event:${event.id}` }
      )
    );

    ctx.logger.info("stripe.invoice.uncollectible.applied", {
      stripeEventId: event.id,
      stripeInvoiceId,
      pharmaxInvoiceId: target.invoiceId,
      transitioned: result.transitioned,
    });
  };

  const handleInvoicePaymentFailed = async (
    event: Stripe.Event,
    ctx: { logger: Logger; receivedAt: Date }
  ): Promise<void> => {
    const { id: stripeInvoiceId, invoice } = requireStripeInvoiceId(event);
    const target = await resolvePharmaxInvoice(client, stripeInvoiceId);
    if (target === null) {
      ctx.logger.info("stripe.invoice.payment_failed.orphan", {
        stripeEventId: event.id,
        stripeInvoiceId,
      });
      return;
    }

    // Try to surface failure reason from the latest charge's
    // failure_code / failure_message when expanded; fall back to
    // generic. The Stripe SDK exposes these as optional strings.
    const charge = (invoice as unknown as { charge?: Stripe.Charge | string | null }).charge;
    const failureCode =
      charge && typeof charge === "object" && "failure_code" in charge
        ? (charge.failure_code ?? undefined)
        : undefined;
    const failureMessage =
      charge && typeof charge === "object" && "failure_message" in charge
        ? (charge.failure_message ?? undefined)
        : undefined;

    const failedAtUnix = Math.floor(event.created ?? Date.now() / 1000);

    await withSystemContext("worker-drain:stripe-invoice-payment-failed", async () =>
      executeSystemCommand(
        RecordInvoicePaymentFailure,
        {
          invoiceId: target.invoiceId,
          organizationId: target.organizationId,
          stripeInvoiceId,
          stripeEventId: event.id,
          ...(failureCode !== undefined ? { failureCode } : {}),
          ...(failureMessage !== undefined ? { failureMessage } : {}),
          ...(typeof invoice.amount_due === "number"
            ? { attemptedAmountCents: invoice.amount_due }
            : {}),
          ...(typeof invoice.next_payment_attempt === "number"
            ? {
                nextAttemptAt: new Date(invoice.next_payment_attempt * 1000).toISOString(),
              }
            : {}),
          failedAt: new Date(failedAtUnix * 1000).toISOString(),
        },
        { idempotencyKey: `stripe-event:${event.id}` }
      )
    );

    ctx.logger.info("stripe.invoice.payment_failed.applied", {
      stripeEventId: event.id,
      stripeInvoiceId,
      pharmaxInvoiceId: target.invoiceId,
      failureCode: failureCode ?? null,
    });
  };

  const handleChargeRefunded = async (
    event: Stripe.Event,
    ctx: { logger: Logger; receivedAt: Date }
  ): Promise<void> => {
    const charge = event.data.object as Stripe.Charge;
    if (typeof charge.id !== "string" || charge.id.length === 0) {
      throw new errors.InternalError({
        code: "STRIPE_HANDLER_CHARGE_ID_MISSING",
        message: "charge.refunded event has no charge.id; refusing to dispatch.",
        metadata: { stripeEventId: event.id, eventType: event.type },
      });
    }

    // `charge.refunds.data` is the list of refunds for this charge.
    // A `charge.refunded` event fires after EACH refund, but the
    // payload includes all refunds to date. We pick the most-recent
    // refund (latest created_at) — that's the one this event is
    // reporting. (Stripe's webhook delivery contract guarantees one
    // event per refund, so we don't loop the list here.)
    const refunds = (charge as unknown as { refunds?: Stripe.ApiList<Stripe.Refund> | null })
      .refunds;
    const latest = refunds?.data.slice().sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
    if (latest === undefined) {
      ctx.logger.warn("stripe.charge.refunded.no_refund_in_payload", {
        stripeEventId: event.id,
        stripeChargeId: charge.id,
      });
      return;
    }

    const refundedAtUnix = latest.created ?? Math.floor(event.created ?? Date.now() / 1000);

    const result = await withSystemContext("worker-drain:stripe-charge-refunded", async () =>
      executeSystemCommand(
        RecordRefundReceived,
        {
          stripeChargeId: charge.id!,
          stripeRefundId: latest.id,
          amountCents: latest.amount,
          stripeStatus: (latest.status ?? "succeeded") as
            | "succeeded"
            | "pending"
            | "failed"
            | "canceled",
          ...(latest.reason !== null && latest.reason !== undefined
            ? {
                stripeReason: latest.reason as
                  | "duplicate"
                  | "fraudulent"
                  | "requested_by_customer"
                  | "expired_uncaptured_charge",
              }
            : {}),
          stripeEventId: event.id,
          refundedAt: new Date(refundedAtUnix * 1000).toISOString(),
        },
        { idempotencyKey: `stripe-event:${event.id}` }
      )
    );

    ctx.logger.info("stripe.charge.refunded.applied", {
      stripeEventId: event.id,
      stripeChargeId: charge.id,
      stripeRefundId: latest.id,
      recognized: result.recognized,
      alreadyRecorded: result.alreadyRecorded,
      pharmaxInvoiceId: result.invoiceId,
    });
  };

  // Log-only handler for unmapped events the dispatcher still
  // accepts. These land in the SupportedStripeEventType allowlist
  // but don't yet have a domain command behind them. Log + no-op
  // so the drain marks them SUCCEEDED rather than retrying forever.
  const logOnly =
    (eventType: string) =>
    async (event: Stripe.Event, ctx: { logger: Logger; receivedAt: Date }): Promise<void> => {
      ctx.logger.info("stripe.event.log_only", {
        stripeEventId: event.id,
        eventType,
        objectId: (event.data.object as { id?: string } | null)?.id ?? null,
      });
    };

  return {
    "invoice.paid": handleInvoicePaid,
    "invoice.voided": handleInvoiceVoided,
    "invoice.marked_uncollectible": handleInvoiceUncollectible,
    "invoice.payment_failed": handleInvoicePaymentFailed,
    // Echo events from our own pushes — Stripe fires them after we
    // create + finalize the invoice. We already have the linkage
    // via `RecordStripeInvoicePushed`; just log + acknowledge.
    "invoice.created": logOnly("invoice.created"),
    "invoice.finalized": logOnly("invoice.finalized"),
    // Refund reconciliation: when Stripe reports a refund (whether
    // operator-issued via IssueRefund or out-of-band from the Stripe
    // dashboard), RecordRefundReceived idempotently writes the
    // ledger entry. The "already recorded" branch covers the
    // Pharmax-initiated path (IssueRefund wrote the line before the
    // webhook arrived).
    "charge.refunded": handleChargeRefunded,
    // Customer + payment-intent events land in future slices
    // (notifications, non-invoice direct charges). Log so we know
    // they're arriving.
    "customer.created": logOnly("customer.created"),
    "customer.updated": logOnly("customer.updated"),
    "customer.deleted": logOnly("customer.deleted"),
    "payment_intent.succeeded": logOnly("payment_intent.succeeded"),
    "payment_intent.payment_failed": logOnly("payment_intent.payment_failed"),
  };
}

/**
 * Default empty registry retained for tests that exercise the
 * drainer without the full Prisma surface. Production wiring lives
 * in `apps/worker/src/main.ts` via `createStripeEventHandlers`.
 */
export const stripeEventHandlers: HandlerMap = {};
