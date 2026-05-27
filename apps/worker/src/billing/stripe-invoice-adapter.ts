// Production adapter for `StripeInvoicePort`.
//
// Wires the Stripe SDK to the port contract so the outbox handler
// for `billing.invoice.finalized.v1` can push a finalized Pharmax
// invoice into Stripe without importing `stripe` itself.
//
// Stripe call sequence:
//
//   1. invoiceItems.create({ customer, currency, amount, description,
//      ... }, { idempotencyKey: "pharmax-line:{id}" })       — once per line.
//   2. invoices.create({ customer, collection_method: "send_invoice",
//      days_until_due, ... }, { idempotencyKey: "pharmax-invoice:{id}" })
//      — invoice picks up any pending items for that customer.
//   3. invoices.finalizeInvoice(invoice.id)                  — transitions
//      DRAFT → OPEN in Stripe (sends if `auto_advance`).
//
// Idempotency is anchored on the Pharmax ids — re-running the push
// after a transient failure returns the SAME Stripe invoice rather
// than creating a duplicate.
//
// PHI: the invoice line descriptions are sanitized at materialization
// time (currently a flat "Shipped prescription order (dispense fee)").
// No PHI flows to Stripe.

import type { StripeInvoicePort, StripePushRequest, StripePushResult } from "@pharmax/billing";
import { STRIPE_PUSH_API_ERROR } from "@pharmax/billing";
import { errors } from "@pharmax/platform-core";
import type Stripe from "stripe";

export interface CreateStripeInvoiceAdapterOptions {
  /** Stripe SDK singleton (constructed in main.ts when STRIPE_SECRET_KEY is set). */
  readonly stripe: Stripe;
}

export function createStripeInvoiceAdapter(
  options: CreateStripeInvoiceAdapterOptions
): StripeInvoicePort {
  const { stripe } = options;

  return {
    async pushInvoice(request: StripePushRequest): Promise<StripePushResult> {
      try {
        // 1. Attach line items to the customer. Stripe picks pending
        // items up automatically when we create the invoice below.
        for (const line of request.lines) {
          await stripe.invoiceItems.create(
            {
              customer: request.stripeCustomerId,
              currency: request.currency,
              amount: line.amountCents,
              description: line.description,
              quantity: Math.max(1, Math.round(line.quantity)),
              metadata: {
                pharmaxLineId: line.pharmaxLineId,
                pharmaxInvoiceId: request.pharmaxInvoiceId,
              },
            },
            { idempotencyKey: `pharmax-line:${line.pharmaxLineId}` }
          );
        }

        // 2. Create the invoice. With `collection_method: send_invoice`,
        // Stripe emails the customer rather than auto-charging.
        const created = await stripe.invoices.create(
          {
            customer: request.stripeCustomerId,
            collection_method: "send_invoice",
            days_until_due: request.daysUntilDue,
            currency: request.currency,
            description: `Pharmax invoice ${request.invoiceNumber}`,
            metadata: {
              pharmaxInvoiceId: request.pharmaxInvoiceId,
              pharmaxInvoiceNumber: request.invoiceNumber,
              pharmaxOrganizationId: request.organizationId,
              pharmaxClinicId: request.clinicId,
            },
          },
          { idempotencyKey: `pharmax-invoice:${request.pharmaxInvoiceId}` }
        );

        if (typeof created.id !== "string" || created.id.length === 0) {
          throw new errors.InternalError({
            code: STRIPE_PUSH_API_ERROR,
            message: "Stripe invoice create returned without an id.",
            metadata: { pharmaxInvoiceId: request.pharmaxInvoiceId },
          });
        }

        // 3. Finalize. Idempotent on the Stripe side — re-finalizing
        // an already-finalized invoice returns the same row.
        const finalized = await stripe.invoices.finalizeInvoice(created.id);

        const status = (finalized.status ?? "draft") as StripePushResult["stripeStatus"];
        const url =
          typeof finalized.hosted_invoice_url === "string" ? finalized.hosted_invoice_url : null;

        return Object.freeze({
          stripeInvoiceId: created.id,
          stripeStatus: status,
          hostedInvoiceUrl: url,
        });
      } catch (cause) {
        if (cause instanceof errors.PharmaxError) {
          throw cause;
        }
        // Wrap Stripe SDK errors. The Stripe error object has a
        // `type` + `code` shape; we surface what's safe (no
        // request bodies, no card data — none of those exist in
        // this flow anyway, but defense in depth).
        const code = (cause as { code?: string } | undefined)?.code ?? STRIPE_PUSH_API_ERROR;
        const message = cause instanceof Error ? cause.message : "unknown";
        throw new errors.InternalError({
          code: STRIPE_PUSH_API_ERROR,
          message: `Stripe invoice push failed: ${message}`,
          metadata: {
            pharmaxInvoiceId: request.pharmaxInvoiceId,
            stripeErrorCode: code,
          },
        });
      }
    },
  };
}
