// Port (interface) for issuing Stripe refunds. Mirrors the
// `StripeInvoicePort` pattern — the production adapter lives in
// `apps/worker/src/billing/stripe-refund-adapter.ts` so the
// domain package stays SDK-free.
//
// Why a port instead of direct SDK calls inside the command:
//
//   - Tests inject a deterministic stub; no fake-Stripe-server
//     dependency for unit-level coverage.
//   - The same command + ledger writeback works for any payment
//     processor — swap the adapter to swap the processor.
//   - The Stripe SDK is bundle-heavy; keeping it out of the
//     domain package means it's loaded ONLY where it's actually
//     dispatched (worker + web), not in every consumer.
//
// Idempotency contract:
//
//   The adapter MUST use the Pharmax refund key as Stripe's
//   `Idempotency-Key` header. Retrying the same refund request
//   resolves to the SAME Stripe refund (not a duplicate).

export interface StripeRefundRequest {
  /** Pharmax invoice id this refund attaches to (used for idempotency). */
  readonly pharmaxInvoiceId: string;
  /** The Stripe charge to refund against. */
  readonly stripeChargeId: string;
  /** Refund amount in cents. May be less than the original charge for partials. */
  readonly amountCents: number;
  /**
   * Stripe-canonical refund reason. `requested_by_customer` is the
   * default; `duplicate` and `fraudulent` have specific semantics
   * (the latter flags the customer record).
   */
  readonly reason: "duplicate" | "fraudulent" | "requested_by_customer";
  /**
   * Pharmax-side operator reason free-text. Forwarded as Stripe
   * metadata for operator dashboard traceability; NOT used as the
   * refund's structured reason.
   */
  readonly operatorNote?: string;
  /**
   * Stable Pharmax-side id for this refund attempt. The adapter
   * uses it as the Stripe idempotency key.
   */
  readonly pharmaxRefundKey: string;
}

export interface StripeRefundResult {
  readonly stripeRefundId: string;
  /**
   * Stripe-reported status. `succeeded` is the happy path; `pending`
   * means Stripe is still processing (rare — usually for non-card
   * payment methods). `failed` / `canceled` are surfaced for
   * operator alerting.
   */
  readonly stripeStatus: "succeeded" | "pending" | "failed" | "canceled";
  readonly amountCents: number;
}

export interface StripeRefundPort {
  /**
   * Issue a refund. Idempotent on `pharmaxRefundKey` — re-running
   * the same request returns the SAME Stripe refund id.
   */
  issueRefund(request: StripeRefundRequest): Promise<StripeRefundResult>;
}

// Error codes the production adapter MAY throw via
// `errors.InternalError` so the command can map them to
// operator-facing messages.
export const STRIPE_REFUND_API_ERROR = "STRIPE_REFUND_API_ERROR";
export const STRIPE_REFUND_CHARGE_NOT_REFUNDABLE = "STRIPE_REFUND_CHARGE_NOT_REFUNDABLE";
