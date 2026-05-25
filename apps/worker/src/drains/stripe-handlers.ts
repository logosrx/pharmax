// Stripe webhook event handlers (worker side).
//
// Mirrors apps/web/src/server/billing/handlers.ts in shape but is a
// SEPARATE registry: the web app's map is irrelevant at the webhook
// transport edge (which only persists the event), while THIS map is
// what the worker uses to actually process events.
//
// Intentionally empty for Phase 1. Real handlers (invoice.paid,
// invoice.payment_failed, payment_intent.succeeded) land alongside
// the billing domain commands in Phase 5. Each handler MUST be
// idempotent and MUST go through the command bus for any workflow
// mutation.

import type { billing } from "@pharmax/platform-core";

type HandlerMap = billing.CreateDispatcherInput["handlers"];

export const stripeEventHandlers: HandlerMap = {};
