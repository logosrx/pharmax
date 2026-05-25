// Stripe webhook receiver.
//
// This route is the transport-edge ONLY. Per docs/BILLING.md it MUST:
//   1. Read the raw request body (Stripe signature is over raw bytes).
//   2. Verify signature against the webhook secret.
//   3. Persist the event idempotently and return 2xx fast.
//   4. NOT execute domain side effects — that is the worker's job.
//
// The worker (apps/worker, next PR) drains the `stripe_webhook_event`
// table and calls `processStripeWebhookEvent` against the dispatcher.
//
// Returns:
//   200 + { status: "accepted" | "duplicate" | "ignored", ... }
//   400 + { status: "missing_signature" | "invalid_signature" }
//   503 + { status: "stripe_not_configured" } when env keys are absent

import { NextResponse, type NextRequest } from "next/server";

import { billing } from "@pharmax/platform-core";

import { stripeWebhookEventStore } from "@/server/billing/stripe-webhook-event-store";
import { getStripe } from "@/server/billing/stripe-client";
import { env } from "@/server/env";
import { logger } from "@/server/logger";

// Stripe signs raw bytes. We MUST opt out of Next's body parsing.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const stripe = getStripe();

  if (stripe === null || !env.STRIPE_WEBHOOK_SECRET) {
    logger.warn("stripe.webhook.not_configured");
    return NextResponse.json(
      {
        status: "stripe_not_configured",
        message: "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set to enable this endpoint.",
      },
      { status: 503 }
    );
  }

  const verifier = billing.createStripeWebhookSignatureVerifier(stripe);
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("stripe-signature");

  const result = await billing.handleStripeWebhook(
    { rawBody, signatureHeader },
    {
      verifier,
      eventStore: stripeWebhookEventStore,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      logger,
    }
  );

  if (result.status === "missing_signature" || result.status === "invalid_signature") {
    return NextResponse.json({ status: result.status }, { status: result.httpStatus });
  }

  return NextResponse.json(
    {
      status: result.status,
      stripeEventId: result.stripeEventId,
      eventType: result.eventType,
    },
    { status: result.httpStatus }
  );
}

export function GET() {
  // Stripe never GETs this URL; explicit 405 makes accidental browser
  // visits and uptime probes obvious in logs.
  return NextResponse.json(
    { status: "method_not_allowed", allow: "POST" },
    { status: 405, headers: { Allow: "POST" } }
  );
}
