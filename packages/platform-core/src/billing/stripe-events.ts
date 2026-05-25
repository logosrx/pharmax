// Stripe event types Pharmax processes for billing.
//
// This is an explicit allowlist. Any event delivered by Stripe that is not
// in this set is still recorded for audit (status = IGNORED) but is NOT
// dispatched to a domain handler. New event types must be added here
// intentionally — never with a wildcard — to avoid silently widening the
// surface that drives billing state.

export const SUPPORTED_STRIPE_EVENT_TYPES = [
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "invoice.created",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "charge.refunded",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
] as const;

export type SupportedStripeEventType = (typeof SUPPORTED_STRIPE_EVENT_TYPES)[number];

const SUPPORTED_STRIPE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(SUPPORTED_STRIPE_EVENT_TYPES);

export function isSupportedStripeEventType(value: string): value is SupportedStripeEventType {
  return SUPPORTED_STRIPE_EVENT_TYPE_SET.has(value);
}
