// Production adapter for `StripeRefundPort`.
//
// Mirrors the invoice-push adapter shape. The SDK call is wrapped
// in a try/catch that surfaces Stripe-side failure modes as typed
// `errors.InternalError` codes so the `IssueRefund` command can
// render operator-friendly messages.
//
// Stripe API call:
//
//   stripe.refunds.create({
//     charge,
//     amount,
//     reason,
//     metadata,
//   }, { idempotencyKey: pharmaxRefundKey })
//
// Idempotency: the `pharmaxRefundKey` Pharmax-generated id is
// passed as Stripe's `Idempotency-Key` header so retries
// converge on the SAME Stripe refund id rather than creating
// duplicates.

import type { StripeRefundPort, StripeRefundRequest, StripeRefundResult } from "@pharmax/billing";
import { STRIPE_REFUND_API_ERROR, STRIPE_REFUND_CHARGE_NOT_REFUNDABLE } from "@pharmax/billing";
import { errors } from "@pharmax/platform-core";
import type Stripe from "stripe";

export interface CreateStripeRefundAdapterOptions {
  readonly stripe: Stripe;
}

export function createStripeRefundAdapter(
  options: CreateStripeRefundAdapterOptions
): StripeRefundPort {
  const { stripe } = options;

  return {
    async issueRefund(request: StripeRefundRequest): Promise<StripeRefundResult> {
      try {
        const refund = await stripe.refunds.create(
          {
            charge: request.stripeChargeId,
            amount: request.amountCents,
            reason: request.reason,
            metadata: {
              pharmaxInvoiceId: request.pharmaxInvoiceId,
              pharmaxRefundKey: request.pharmaxRefundKey,
              ...(request.operatorNote !== undefined
                ? { pharmaxOperatorNote: request.operatorNote.slice(0, 500) }
                : {}),
            },
          },
          { idempotencyKey: request.pharmaxRefundKey }
        );

        if (typeof refund.id !== "string" || refund.id.length === 0) {
          throw new errors.InternalError({
            code: STRIPE_REFUND_API_ERROR,
            message: "Stripe refunds.create returned without an id.",
            metadata: { pharmaxRefundKey: request.pharmaxRefundKey },
          });
        }

        const status = (refund.status ?? "succeeded") as StripeRefundResult["stripeStatus"];

        return Object.freeze({
          stripeRefundId: refund.id,
          stripeStatus: status,
          amountCents: refund.amount ?? request.amountCents,
        });
      } catch (cause) {
        if (cause instanceof errors.PharmaxError) {
          throw cause;
        }
        // Stripe error envelope; map well-known codes to typed
        // domain errors so the operator UI can render specific
        // messages.
        const code = (cause as { code?: string } | undefined)?.code;
        const message = cause instanceof Error ? cause.message : "unknown";
        if (code === "charge_already_refunded" || code === "charge_disputed") {
          throw new errors.InternalError({
            code: STRIPE_REFUND_CHARGE_NOT_REFUNDABLE,
            message: `Stripe refused refund: ${message}`,
            metadata: {
              pharmaxRefundKey: request.pharmaxRefundKey,
              stripeChargeId: request.stripeChargeId,
              stripeErrorCode: code,
            },
          });
        }
        throw new errors.InternalError({
          code: STRIPE_REFUND_API_ERROR,
          message: `Stripe refund failed: ${message}`,
          metadata: {
            pharmaxRefundKey: request.pharmaxRefundKey,
            stripeErrorCode: code ?? "unknown",
          },
        });
      }
    },
  };
}
