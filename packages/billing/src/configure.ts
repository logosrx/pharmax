// Process-wide billing configuration.
//
// Mirrors `configureShipping` from `@pharmax/shipping`. The web
// tier and worker both call `configureBilling` at boot to wire the
// Stripe refund port; the `IssueRefund` command reads it from the
// configured registry at call time.
//
// Why a single config slot instead of multiple:
//
//   - Today there's exactly one external billing-side port (refund).
//     The invoice-push port is worker-only and threaded through the
//     outbox handler factory directly — no need for it in the
//     synchronous command path.
//
//   - When more ports land (subscription cancel, customer portal
//     URLs, etc.) this object grows naturally without a contract
//     break for existing callers.
//
// `null` is a valid value: dev / test environments without a
// Stripe key wire `stripeRefundPort: null`. The `IssueRefund`
// command surfaces `BILLING_NOT_CONFIGURED` rather than throwing
// the bus's generic config error.

import { errors, runtime } from "@pharmax/platform-core";

import type { StripeRefundPort } from "./ports/stripe-refund-port.js";

export const BILLING_NOT_CONFIGURED = "BILLING_NOT_CONFIGURED";
export const BILLING_REFUND_NOT_CONFIGURED = "BILLING_REFUND_NOT_CONFIGURED";

export interface BillingConfiguration {
  /**
   * Production Stripe refund port. `null` when STRIPE_SECRET_KEY is
   * unset; `IssueRefund` then refuses with `BILLING_REFUND_NOT_CONFIGURED`
   * so operators get a clear "wire Stripe before issuing refunds"
   * message instead of an SDK constructor error.
   */
  readonly stripeRefundPort: StripeRefundPort | null;
}

// globalThis-backed so boot (Next instrumentation bundle) and use
// (route bundles) share ONE configuration despite webpack giving each
// bundle its own copy of this module. See platform-core
// runtime/global-singleton.ts for the full rationale.
const box = runtime.globalSingletonBox<BillingConfiguration>("pharmax:billing:config");

export function configureBilling(config: BillingConfiguration): void {
  box.value = Object.freeze({ stripeRefundPort: config.stripeRefundPort });
}

export function getBillingConfiguration(): BillingConfiguration {
  if (box.value === null) {
    throw new errors.InternalError({
      code: BILLING_NOT_CONFIGURED,
      message:
        "@pharmax/billing is not configured. Call configureBilling({ stripeRefundPort }) at boot before invoking refund commands.",
    });
  }
  return box.value;
}

export function getStripeRefundPort(): StripeRefundPort {
  const port = getBillingConfiguration().stripeRefundPort;
  if (port === null) {
    throw new errors.InternalError({
      code: BILLING_REFUND_NOT_CONFIGURED,
      message:
        "Stripe refund port is not configured (STRIPE_SECRET_KEY likely unset). Wire it before issuing refunds.",
    });
  }
  return port;
}

export function resetBillingConfigurationForTests(): void {
  box.value = null;
}
