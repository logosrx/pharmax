// Clerk webhook receiver.
//
// Transport layer ONLY:
//   1. Read the raw request body — Svix signs raw bytes, so we MUST
//      not let Next parse the body as JSON before we verify.
//   2. Verify the Svix signature against CLERK_WEBHOOK_SECRET.
//   3. Dedupe on the `svix-id` header against `clerk_webhook_event`
//      (the idempotency ledger). A re-delivery hits the unique
//      constraint and we ack 200 fast without re-running the
//      dispatcher.
//   4. Hand the parsed event to `dispatchClerkWebhookEvent`.
//   5. Update the ledger row's status (APPLIED / NOOP / FAILED).
//   6. Return 2xx on success, 5xx on dispatcher failure (Clerk
//      retries via Svix on 5xx; our dedupe makes the retry safe).
//
// Failure modes:
//   503 + { status: "clerk_webhook_not_configured" }
//        — CLERK_WEBHOOK_SECRET unset (dev/test or mis-deployed prod).
//   400 + { status: "invalid_signature" } — Svix rejected the signature.
//   400 + { status: "invalid_payload" } — body parsed but is the wrong shape.
//   200 + { status: "applied" | "noop_*" } — dispatcher handled.
//   200 + { status: "replay" } — already-recorded svix-id; skipped.
//   500 + { status: "dispatch_failed" } — handler threw; Clerk retries.
//
// Idempotency contract:
//
//   1. The `clerk_webhook_event` row inserts BEFORE the dispatcher
//      runs, with `status=PENDING` + `signatureVerifiedAt`. The
//      `svixMessageId` unique constraint is the dedupe.
//   2. A duplicate INSERT raises P2002. We treat that as a fast
//      replay path: read the existing row, log it, return 200.
//   3. If the existing row is `PENDING` (a previous dispatch
//      crashed mid-tx, or the receiver was killed before status
//      update), we DO re-dispatch — that's a real retry surface,
//      not a replay. The dispatcher itself is idempotent at the
//      row-level (link/sync/terminate are guarded updates), so
//      re-running is safe.
//
// PHI invariant: Clerk events do not carry PHI. We never log the
// raw body. We log structured event metadata + `svix-id` only.

import "server-only";

import { Prisma, prisma } from "@pharmax/database";
import { NextResponse, type NextRequest } from "next/server";
import { Webhook, WebhookVerificationError } from "svix";

import {
  dispatchClerkWebhookEvent,
  type ClerkWebhookEvent,
  type DispatchOutcome,
} from "@/server/auth/clerk-webhook-handlers";
import { env } from "@/server/env";
import { logger } from "@/server/logger";

// Svix signs raw bytes. Opt out of Next's body parsing so we can re-verify.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!env.CLERK_WEBHOOK_SECRET) {
    logger.warn("clerk.webhook.not_configured", {
      event: "clerk.webhook.not_configured",
    });
    return NextResponse.json(
      {
        status: "clerk_webhook_not_configured",
        message: "CLERK_WEBHOOK_SECRET must be set to enable this endpoint.",
      },
      { status: 503 }
    );
  }

  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");

  if (svixId === null || svixTimestamp === null || svixSignature === null) {
    logger.warn("clerk.webhook.missing_signature_headers", {
      event: "clerk.webhook.missing_signature_headers",
      hasId: svixId !== null,
      hasTimestamp: svixTimestamp !== null,
      hasSignature: svixSignature !== null,
    });
    return NextResponse.json({ status: "invalid_signature" }, { status: 400 });
  }

  // Trust boundary: everything BEFORE this read is unauthenticated
  // input. The signature verification below is what makes the body
  // trustworthy. We MUST verify the raw bytes, not parsed JSON.
  const rawBody = await request.text();

  let verified: unknown;
  let signatureVerifiedAt: Date;
  try {
    const wh = new Webhook(env.CLERK_WEBHOOK_SECRET);
    verified = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
    signatureVerifiedAt = new Date();
  } catch (cause) {
    const isSig = cause instanceof WebhookVerificationError;
    logger.warn("clerk.webhook.signature_rejected", {
      event: "clerk.webhook.signature_rejected",
      svixId,
      reason: isSig ? "verification_error" : "unexpected_error",
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json({ status: "invalid_signature" }, { status: 400 });
  }

  if (!isClerkEventShape(verified)) {
    logger.warn("clerk.webhook.invalid_payload_shape", {
      event: "clerk.webhook.invalid_payload_shape",
      svixId,
    });
    return NextResponse.json({ status: "invalid_payload" }, { status: 400 });
  }

  const event = verified as ClerkWebhookEvent;
  const eventType = event.type;

  // -------------------------------------------------------------------
  // Idempotency ledger.
  //
  // Insert the receipt BEFORE dispatching. A redelivery races against
  // this insert; the unique index on `svixMessageId` is the dedupe.
  // -------------------------------------------------------------------

  let ledgerRowId: string;
  try {
    const created = await prisma.clerkWebhookEvent.create({
      data: {
        svixMessageId: svixId,
        eventType,
        payload: event as unknown as Prisma.InputJsonValue,
        status: "PENDING",
        signatureVerifiedAt,
      },
    });
    ledgerRowId = created.id;
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      // Replay path. Read the existing row to determine whether the
      // earlier dispatch actually completed; if it's still PENDING
      // we DO re-run (a previous receiver crashed mid-tx).
      const existing = await prisma.clerkWebhookEvent.findUnique({
        where: { svixMessageId: svixId },
        select: { id: true, status: true, dispatchOutcome: true, attempts: true },
      });
      if (existing === null) {
        logger.error("clerk.webhook.dedupe_lookup_failed", {
          event: "clerk.webhook.dedupe_lookup_failed",
          svixId,
        });
        return NextResponse.json({ status: "dispatch_failed", eventType }, { status: 500 });
      }
      if (existing.status !== "PENDING") {
        logger.info("clerk.webhook.replay_ack", {
          event: "clerk.webhook.replay_ack",
          svixId,
          eventType,
          ledgerRowId: existing.id,
          ledgerStatus: existing.status,
          previousOutcome: existing.dispatchOutcome,
          attempts: existing.attempts,
        });
        return NextResponse.json(
          {
            status: "replay",
            eventType,
            previousOutcome: existing.dispatchOutcome,
          },
          { status: 200 }
        );
      }
      // The PENDING row exists from a previous attempt that never
      // wrote a terminal status. Reuse its id and re-dispatch — the
      // handlers' guarded updates make this safe.
      ledgerRowId = existing.id;
    } else {
      logger.error("clerk.webhook.ledger_insert_failed", {
        event: "clerk.webhook.ledger_insert_failed",
        svixId,
        eventType,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return NextResponse.json({ status: "dispatch_failed", eventType }, { status: 500 });
    }
  }

  // -------------------------------------------------------------------
  // Dispatch + finalize the ledger row.
  // -------------------------------------------------------------------

  const beforeDispatch = Date.now();
  let outcome: DispatchOutcome;
  try {
    outcome = await dispatchClerkWebhookEvent(event);
  } catch (cause) {
    const errorMessage = cause instanceof Error ? cause.message : String(cause);
    logger.error("clerk.webhook.dispatch_failed", {
      event: "clerk.webhook.dispatch_failed",
      svixId,
      eventType,
      error: errorMessage,
    });
    await prisma.clerkWebhookEvent
      .update({
        where: { id: ledgerRowId },
        data: {
          status: "FAILED",
          attempts: { increment: 1 },
          lastError: errorMessage.slice(0, 1024),
          dispatchedAt: new Date(),
        },
      })
      .catch((updateCause) => {
        // Ledger update failure is observability-only; the dispatcher
        // already failed and Clerk will retry. We do not want a
        // ledger-update error to mask the real problem.
        logger.warn("clerk.webhook.ledger_update_failed_after_dispatch_fail", {
          event: "clerk.webhook.ledger_update_failed_after_dispatch_fail",
          svixId,
          ledgerRowId,
          error: updateCause instanceof Error ? updateCause.message : String(updateCause),
        });
      });
    return NextResponse.json({ status: "dispatch_failed", eventType }, { status: 500 });
  }

  await prisma.clerkWebhookEvent
    .update({
      where: { id: ledgerRowId },
      data: {
        status: outcome === "applied" ? "APPLIED" : "NOOP",
        dispatchOutcome: outcome,
        attempts: { increment: 1 },
        dispatchedAt: new Date(),
        lastError: null,
      },
    })
    .catch((cause) => {
      // The dispatch succeeded; failing to update the ledger row
      // status doesn't change correctness because the next replay
      // will read PENDING and re-run (which is itself idempotent).
      // Surface but don't fail the request.
      logger.warn("clerk.webhook.ledger_update_failed_after_dispatch_ok", {
        event: "clerk.webhook.ledger_update_failed_after_dispatch_ok",
        svixId,
        ledgerRowId,
        outcome,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });

  logger.info("clerk.webhook.dispatched", {
    event: "clerk.webhook.dispatched",
    svixId,
    eventType,
    outcome,
    ledgerRowId,
    elapsedMs: Date.now() - beforeDispatch,
  });
  return NextResponse.json({ status: outcome, eventType }, { status: 200 });
}

export function GET() {
  // Clerk never GETs this URL; explicit 405 makes accidental browser
  // visits and uptime probes obvious in logs.
  return NextResponse.json(
    { status: "method_not_allowed", allow: "POST" },
    { status: 405, headers: { Allow: "POST" } }
  );
}

function isClerkEventShape(value: unknown): value is { type: string; data: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === "string" && "data" in v;
}

function isUniqueViolation(cause: unknown): boolean {
  return cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002";
}
