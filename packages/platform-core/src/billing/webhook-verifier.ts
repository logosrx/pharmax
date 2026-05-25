// Stripe webhook signature verification.
//
// Wraps `stripe.webhooks.constructEventAsync` so the rest of the billing
// pipeline never touches Stripe SDK error types directly. Returns a typed
// result so the caller can branch on outcome without try/catch around
// untyped errors.
//
// IMPORTANT: callers MUST pass the RAW request body (string or Buffer) and
// the unmodified `Stripe-Signature` header value. Any JSON parse, body
// rewrite, or whitespace change invalidates the signature.

import type Stripe from "stripe";

import { StripeSignatureError, StripeWebhookConfigError } from "./errors.js";

export interface VerifyStripeSignatureInput {
  readonly rawBody: string | Buffer;
  readonly signatureHeader: string;
  readonly webhookSecret: string;
  readonly toleranceSeconds?: number;
}

export type StripeSignatureVerificationResult =
  | { readonly ok: true; readonly event: Stripe.Event }
  | { readonly ok: false; readonly error: StripeSignatureError };

export interface StripeWebhookSignatureVerifier {
  verify(input: VerifyStripeSignatureInput): Promise<StripeSignatureVerificationResult>;
}

export function createStripeWebhookSignatureVerifier(
  stripe: Stripe
): StripeWebhookSignatureVerifier {
  return {
    async verify(input) {
      if (input.webhookSecret.length === 0) {
        throw new StripeWebhookConfigError(
          "Stripe webhook secret is not configured (empty string)."
        );
      }
      if (input.signatureHeader.length === 0) {
        return { ok: false, error: new StripeSignatureError("Missing Stripe-Signature header") };
      }
      try {
        const event = await stripe.webhooks.constructEventAsync(
          input.rawBody,
          input.signatureHeader,
          input.webhookSecret,
          input.toleranceSeconds
        );
        return { ok: true, event };
      } catch (cause) {
        // Stripe.errors.StripeSignatureVerificationError is the canonical
        // signal; we coerce every failure into our typed error to avoid
        // leaking SDK internals.
        return { ok: false, error: new StripeSignatureError(undefined, cause) };
      }
    },
  };
}
