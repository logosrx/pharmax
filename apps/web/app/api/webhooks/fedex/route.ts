// FedEx Advanced Integrated Visibility webhook receiver.
//
// Mirrors the EasyPost webhook route. Transport edge ONLY:
//   1. Read the raw request body (the `fdx-signature` HMAC is over
//      raw bytes).
//   2. Verify the signature against the webhook project's security
//      token.
//   3. Persist the delivery idempotently (PHI-minimized projection)
//      and return 2xx fast.
//   4. NOT execute domain side effects — apps/worker drains
//      `fedex_webhook_event` and runs `RecordShipmentTrackingEvent`
//      inside per-org tenancy.
//
// Returns:
//   200 + { status: "accepted" | "duplicate" | "malformed_body", ... }
//   400 + { status: "missing_signature" | "invalid_signature" }
//   503 + { status: "fedex_not_configured" } when env secret is absent

import { NextResponse, type NextRequest } from "next/server";

import { handleFedExWebhook } from "@pharmax/shipping";

import { fedExWebhookEventStore } from "@/server/shipping/fedex-webhook-event-store";
import { env } from "@/server/env";
import { logger } from "@/server/logger";

// FedEx signs raw bytes. We MUST opt out of Next's body parsing.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!env.FEDEX_WEBHOOK_SECRET) {
    logger.warn("fedex.webhook.not_configured");
    return NextResponse.json(
      {
        status: "fedex_not_configured",
        message: "FEDEX_WEBHOOK_SECRET must be set to enable this endpoint.",
      },
      { status: 503 }
    );
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("fdx-signature");

  const result = await handleFedExWebhook(
    { rawBody, signatureHeader },
    {
      eventStore: fedExWebhookEventStore,
      webhookSecret: env.FEDEX_WEBHOOK_SECRET,
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
    { status: result.status, externalEventId: result.externalEventId },
    { status: result.httpStatus }
  );
}

export function GET() {
  // FedEx never GETs this URL; explicit 405 makes accidental browser
  // visits and uptime probes obvious in logs.
  return NextResponse.json(
    { status: "method_not_allowed", allow: "POST" },
    { status: 405, headers: { Allow: "POST" } }
  );
}
