// EasyPost webhook receiver.
//
// Mirrors the Stripe webhook route. Transport edge ONLY:
//   1. Read the raw request body (signature is HMAC-SHA256 over raw
//      bytes).
//   2. Verify signature against the webhook secret.
//   3. Persist the event idempotently and return 2xx fast.
//   4. NOT execute domain side effects — that is the worker's job
//      (apps/worker drains `easypost_webhook_event` and runs
//      `RecordShipmentTrackingEvent` inside per-org tenancy).
//
// Returns:
//   200 + { status: "accepted" | "duplicate" | "ignored" | "malformed_body", ... }
//   400 + { status: "missing_signature" | "invalid_signature" }
//   503 + { status: "easypost_not_configured" } when env secret is absent

import { NextResponse, type NextRequest } from "next/server";

import { handleEasyPostWebhook } from "@pharmax/shipping";

import { easyPostWebhookEventStore } from "@/server/shipping/easypost-webhook-event-store";
import { env } from "@/server/env";
import { logger } from "@/server/logger";

// EasyPost signs raw bytes. We MUST opt out of Next's body parsing.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!env.EASYPOST_WEBHOOK_SECRET) {
    logger.warn("easypost.webhook.not_configured");
    return NextResponse.json(
      {
        status: "easypost_not_configured",
        message: "EASYPOST_WEBHOOK_SECRET must be set to enable this endpoint.",
      },
      { status: 503 }
    );
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hmac-signature");

  const result = await handleEasyPostWebhook(
    { rawBody, signatureHeader },
    {
      eventStore: easyPostWebhookEventStore,
      webhookSecret: env.EASYPOST_WEBHOOK_SECRET,
      logger,
    }
  );

  if (result.status === "missing_signature" || result.status === "invalid_signature") {
    return NextResponse.json({ status: result.status }, { status: result.httpStatus });
  }

  if (result.status === "malformed_body") {
    return NextResponse.json(
      { status: result.status, reason: result.reason },
      { status: result.httpStatus }
    );
  }

  return NextResponse.json(
    {
      status: result.status,
      externalEventId: result.externalEventId,
      eventType: result.eventType,
    },
    { status: result.httpStatus }
  );
}

export function GET() {
  // EasyPost never GETs this URL; explicit 405 makes accidental
  // browser visits and uptime probes obvious in logs.
  return NextResponse.json(
    { status: "method_not_allowed", allow: "POST" },
    { status: 405, headers: { Allow: "POST" } }
  );
}
