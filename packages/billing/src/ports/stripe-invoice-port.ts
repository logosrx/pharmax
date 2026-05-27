// Port (interface) for pushing a finalized Pharmax invoice to
// Stripe. Implementations live OUTSIDE this package:
//
//   - `apps/worker` ships the production adapter that wires the
//     Stripe SDK to this contract.
//   - Tests inject deterministic stubs.
//
// Why a port:
//
//   - The Stripe SDK is heavy, requires a singleton with a network
//     pool, and ties the test suite to either a real Stripe account
//     or a Stripe-CLI mock. Hiding it behind an interface keeps
//     `@pharmax/billing` SDK-free and lets every test in the
//     package run against a fake.
//
//   - A future provider swap (Chargebee, internal billing) only
//     needs a new adapter satisfying this contract — no domain
//     code changes.
//
// Idempotency contract:
//
//   - The adapter MUST use `pharmaxInvoiceId` (and per-line ids)
//     as Stripe idempotency keys, so a retry of the same push
//     resolves to the same Stripe invoice — not a duplicate.
//   - On success, the adapter returns the `stripeInvoiceId`. The
//     handler then dispatches `RecordStripeInvoicePushed` to
//     write the linkage back transactionally.

export interface StripePushLine {
  readonly pharmaxLineId: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitAmountCents: number;
  /** Pre-multiplied; the adapter trusts this rather than recomputing. */
  readonly amountCents: number;
}

export interface StripePushRequest {
  readonly organizationId: string;
  readonly clinicId: string;
  readonly pharmaxInvoiceId: string;
  readonly invoiceNumber: string;
  readonly stripeCustomerId: string;
  readonly currency: string;
  readonly daysUntilDue: number;
  readonly lines: ReadonlyArray<StripePushLine>;
}

export interface StripePushResult {
  readonly stripeInvoiceId: string;
  readonly stripeStatus: "draft" | "open" | "paid" | "uncollectible" | "void";
  readonly hostedInvoiceUrl: string | null;
}

export interface StripeInvoicePort {
  /**
   * Push a finalized Pharmax invoice as a Stripe invoice with
   * line items, finalized for collection. Idempotent on
   * `pharmaxInvoiceId`.
   */
  pushInvoice(request: StripePushRequest): Promise<StripePushResult>;
}

// Error codes the production adapter (and stubs) MAY throw via
// `errors.InternalError` so the outbox-handler retry policy can
// discriminate.
export const STRIPE_PUSH_CUSTOMER_NOT_LINKED = "STRIPE_PUSH_CUSTOMER_NOT_LINKED";
export const STRIPE_PUSH_API_ERROR = "STRIPE_PUSH_API_ERROR";
