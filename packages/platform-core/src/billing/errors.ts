// Typed errors for the billing module.
//
// Rules:
//   - Error messages MUST NOT contain raw webhook payloads, signatures,
//     secrets, or any patient/clinic identifiers beyond ids that have
//     already been audited (e.g. Stripe event id).
//   - The `cause` chain may carry the original underlying error for
//     server-side logs, but error messages exposed to API responses must
//     remain generic.

export class BillingError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BillingError";
    this.code = code;
  }
}

export class StripeSignatureError extends BillingError {
  public constructor(message = "Stripe signature verification failed", cause?: unknown) {
    super("BILLING_STRIPE_SIGNATURE_INVALID", message, cause === undefined ? undefined : { cause });
    this.name = "StripeSignatureError";
  }
}

export class StripeWebhookConfigError extends BillingError {
  public constructor(message: string) {
    super("BILLING_STRIPE_WEBHOOK_CONFIG", message);
    this.name = "StripeWebhookConfigError";
  }
}

export class StripeWebhookPayloadError extends BillingError {
  public constructor(message = "Stripe webhook payload was malformed", cause?: unknown) {
    super("BILLING_STRIPE_WEBHOOK_MALFORMED", message, cause === undefined ? undefined : { cause });
    this.name = "StripeWebhookPayloadError";
  }
}

export class StripeWebhookEventNotFoundError extends BillingError {
  public constructor(stripeEventId: string) {
    super(
      "BILLING_STRIPE_WEBHOOK_EVENT_NOT_FOUND",
      `Stripe webhook event ${stripeEventId} was not found in the event store`
    );
    this.name = "StripeWebhookEventNotFoundError";
  }
}
