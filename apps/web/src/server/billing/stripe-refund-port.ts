// apps/web Stripe refund port builder.
//
// Returns `null` when STRIPE_SECRET_KEY is unset. The IssueRefund
// command's "refund port not configured" branch surfaces a typed
// error so the operator UI can render a clear message instead of
// the SDK constructor blowing up at request time.
//
// We construct a fresh Stripe SDK here (rather than reusing
// `getStripe()` from `stripe-client.ts`) because the existing
// helper is a singleton tuned for the webhook signature verifier;
// the bootstrap path is a separate touchpoint and we keep the
// dependency local for clarity.

import "server-only";

import type { StripeRefundPort } from "@pharmax/billing";
import { errors } from "@pharmax/platform-core";
import Stripe from "stripe";

import { env } from "../env.js";

export function buildStripeRefundPortFromEnv(): StripeRefundPort | null {
  if (typeof env.STRIPE_SECRET_KEY !== "string" || env.STRIPE_SECRET_KEY.length === 0) {
    return null;
  }
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    typescript: true,
    appInfo: { name: "pharmacy-os", version: "0.1.0" },
  });
  return {
    async issueRefund(request) {
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
        return Object.freeze({
          stripeRefundId: refund.id,
          stripeStatus: (refund.status ?? "succeeded") as
            | "succeeded"
            | "pending"
            | "failed"
            | "canceled",
          amountCents: refund.amount ?? request.amountCents,
        });
      } catch (cause) {
        const code = (cause as { code?: string } | undefined)?.code;
        const message = cause instanceof Error ? cause.message : "unknown";
        throw new errors.InternalError({
          code:
            code === "charge_already_refunded" || code === "charge_disputed"
              ? "STRIPE_REFUND_CHARGE_NOT_REFUNDABLE"
              : "STRIPE_REFUND_API_ERROR",
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
