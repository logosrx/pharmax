// Domain handlers for Stripe webhook events.
//
// Intentionally empty for now. The dispatcher in
// `@pharmax/platform-core/billing` treats unknown event types as a
// successful no-op, so the webhook route is fully end-to-end testable
// today: signature verified → row inserted → row marked SUCCEEDED.
//
// Real handlers (invoice.paid, invoice.payment_failed,
// payment_intent.succeeded, etc.) land alongside the billing domain
// commands. They MUST go through the command bus once it exists; do
// not put workflow mutations directly in this map.

import "server-only";

import type { billing as billingContract } from "@pharmax/platform-core";

type HandlerMap = billingContract.CreateDispatcherInput["handlers"];

export const stripeEventHandlers: HandlerMap = {};
