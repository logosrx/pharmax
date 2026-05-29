// Resend delivery webhook receiver.
//
// Transport layer ONLY:
//   1. Read the raw request body — Svix signs raw bytes, so we
//      MUST not let Next parse it before verifying.
//   2. Verify the Svix signature against RESEND_WEBHOOK_SECRET.
//   3. Dedupe on the `svix-id` header against `resend_webhook_event`
//      (the idempotency ledger). A re-delivery hits the unique
//      constraint and we ack 200 fast.
//   4. Map the event to a `notification_delivery` projection update
//      (pure `mapResendEvent`) and apply it by `providerMessageId`
//      in system context (the webhook has no operator session;
//      delivery rows are tenant-scoped but the row carries its own
//      org, and we update by the globally-unique provider id).
//   5. Record the ledger row's outcome (APPLIED / NOOP / FAILED).
//
// Failure modes:
//   503 + { status: "resend_webhook_not_configured" }
//   400 + { status: "invalid_signature" | "invalid_payload" }
//   200 + { status: "applied" | "noop_*" | "replay" }
//   500 + { status: "apply_failed" } — Resend retries via Svix.
//
// Monotonicity: an event whose `created_at` is older-or-equal to
// the row's `lastEventAt` is dropped (NOOP) so out-of-order Svix
// deliveries can't regress the projection (e.g. a late `sent`
// arriving after `delivered`).
//
// PHI invariant: Resend events carry operator email + subject
// only. We never log the raw body; structured metadata + svix-id
// only.

import "server-only";

import { Prisma, prisma } from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";
import { NextResponse, type NextRequest } from "next/server";
import { Webhook, WebhookVerificationError } from "svix";

import { env } from "@/server/env";
import { logger } from "@/server/logger";
import {
  mapResendEvent,
  type ResendDeliveryUpdate,
  type ResendWebhookEventPayload,
} from "@/server/notifications/resend-webhook";

// Svix signs raw bytes. Opt out of Next's body parsing.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!env.RESEND_WEBHOOK_SECRET) {
    logger.warn("resend.webhook.not_configured", { event: "resend.webhook.not_configured" });
    return NextResponse.json(
      {
        status: "resend_webhook_not_configured",
        message: "RESEND_WEBHOOK_SECRET must be set to enable this endpoint.",
      },
      { status: 503 }
    );
  }

  const rawBody = await request.text();
  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");

  if (svixId === null || svixTimestamp === null || svixSignature === null) {
    return NextResponse.json({ status: "invalid_signature" }, { status: 400 });
  }

  // 1. Verify signature.
  let event: ResendWebhookEventPayload;
  try {
    const wh = new Webhook(env.RESEND_WEBHOOK_SECRET);
    event = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ResendWebhookEventPayload;
  } catch (cause) {
    if (cause instanceof WebhookVerificationError) {
      logger.warn("resend.webhook.invalid_signature", { svixId });
      return NextResponse.json({ status: "invalid_signature" }, { status: 400 });
    }
    logger.error("resend.webhook.verify_error", { svixId, error: cause });
    return NextResponse.json({ status: "invalid_payload" }, { status: 400 });
  }

  const eventType = typeof event.type === "string" ? event.type : "unknown";
  const signatureVerifiedAt = new Date();

  // 2. Insert the idempotency ledger row. Duplicate svix-id → P2002
  //    → fast replay ack.
  let ledgerId: string;
  try {
    const created = await prisma.resendWebhookEvent.create({
      data: {
        svixMessageId: svixId,
        eventType,
        payload: event as unknown as Prisma.InputJsonValue,
        status: "PENDING",
        signatureVerifiedAt,
      },
      select: { id: true },
    });
    ledgerId = created.id;
  } catch (cause) {
    if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
      logger.info("resend.webhook.replay", { svixId, eventType });
      return NextResponse.json({ status: "replay" }, { status: 200 });
    }
    throw cause;
  }

  // 3. Map + apply.
  const mapped = mapResendEvent(event);
  if (!mapped.ok) {
    await markLedger(ledgerId, "NOOP", `unmappable:${mapped.reason}`);
    logger.info("resend.webhook.ignored", { svixId, eventType, reason: mapped.reason });
    return NextResponse.json({ status: `noop_${mapped.reason}` }, { status: 200 });
  }

  try {
    const outcome = await applyDeliveryUpdate(mapped.update);
    await markLedger(ledgerId, outcome === "applied" ? "APPLIED" : "NOOP", outcome);
    logger.info("resend.webhook.processed", {
      svixId,
      eventType,
      providerMessageId: mapped.update.providerMessageId,
      outcome,
    });
    return NextResponse.json(
      { status: outcome === "applied" ? "applied" : `noop_${outcome}` },
      {
        status: 200,
      }
    );
  } catch (cause) {
    await markLedger(ledgerId, "FAILED", cause instanceof Error ? cause.message : "unknown");
    logger.error("resend.webhook.apply_failed", { svixId, eventType, error: cause });
    // 5xx → Svix retries; the ledger dedupe + monotonic guard make
    // the retry safe.
    return NextResponse.json({ status: "apply_failed" }, { status: 500 });
  }
}

type ApplyOutcome = "applied" | "no_row" | "stale";

/**
 * Apply the mapped update to the `notification_delivery` row by
 * `providerMessageId`. System context: the webhook has no operator
 * session, and we look the row up by its globally-unique provider
 * id (the org check is implicit — the row carries its own org and
 * we don't expose it to the caller).
 */
async function applyDeliveryUpdate(update: ResendDeliveryUpdate): Promise<ApplyOutcome> {
  return withSystemContext("web:resend-webhook:apply", async () => {
    const row = await prisma.notificationDelivery.findUnique({
      where: { providerMessageId: update.providerMessageId },
      select: { id: true, lastEventAt: true },
    });
    if (row === null) {
      return "no_row";
    }
    // Monotonic guard: drop stale / duplicate out-of-order events.
    if (row.lastEventAt !== null && update.lastEventAt.getTime() <= row.lastEventAt.getTime()) {
      return "stale";
    }
    await prisma.notificationDelivery.update({
      where: { id: row.id },
      data: {
        lastEventType: update.lastEventType,
        lastEventAt: update.lastEventAt,
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.failureReason !== undefined ? { failureReason: update.failureReason } : {}),
      },
    });
    return "applied";
  });
}

async function markLedger(
  id: string,
  status: "APPLIED" | "NOOP" | "FAILED",
  outcome: string
): Promise<void> {
  await prisma.resendWebhookEvent.update({
    where: { id },
    data: {
      status,
      dispatchOutcome: outcome,
      dispatchedAt: new Date(),
      ...(status === "FAILED" ? { lastError: outcome, attempts: { increment: 1 } } : {}),
    },
  });
}
