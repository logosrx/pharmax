// End-to-end FedEx Advanced Integrated Visibility webhook entry
// point. Same architecture as `handle-easypost-webhook.ts`:
//
//   1. Verify the `fdx-signature` HMAC against the webhook project's
//      security token.
//   2. Parse the body into `(trackingNumber, trackResult)` entries
//      and project them down to the PHI-free storage subset.
//   3. Record the delivery idempotently in `fedex_webhook_event`.
//      FedEx publishes no per-delivery event id, so the idempotency
//      key is a SHA-256 digest of the raw body — a FedEx redelivery
//      of the same message bytes is a no-op insert.
//   4. Return a typed result the transport adapter maps to HTTP
//      (200 for accepted/duplicate/malformed-body, 400 for
//      signature errors).
//
// The handler DOES NOT run domain side effects — a worker drains
// PENDING rows and calls `executeFedExWebhookEventDispatch`.

import { createHash } from "node:crypto";

import type { logger as loggerContract } from "@pharmax/platform-core";

import {
  FedExWebhookPayloadError,
  parseFedExWebhookPayload,
  projectFedExWebhookForStorage,
} from "../carriers/fedex-webhook-payload.js";
import { verifyFedExSignature } from "../carriers/fedex-webhook-signature.js";
import type { FedExSignatureError } from "../carriers/fedex-webhook-signature.js";

import type { FedExRecordReceivedResult, FedExWebhookEventStore } from "./fedex-event-store.js";

type Logger = loggerContract.Logger;

/** Stable `eventType` stamped on every AIV tracking delivery. */
export const FEDEX_WEBHOOK_EVENT_TYPE = "fedex.aiv.track";

export interface HandleFedExWebhookDeps {
  readonly eventStore: FedExWebhookEventStore;
  readonly webhookSecret: string;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

export interface HandleFedExWebhookInput {
  readonly rawBody: string | Buffer;
  readonly signatureHeader: string | null | undefined;
}

export type HandleFedExWebhookResult =
  | {
      readonly status: "accepted";
      readonly httpStatus: 200;
      readonly externalEventId: string;
      readonly record: FedExRecordReceivedResult["record"];
    }
  | {
      readonly status: "duplicate";
      readonly httpStatus: 200;
      readonly externalEventId: string;
      readonly record: FedExRecordReceivedResult["record"];
    }
  | {
      readonly status: "malformed_body";
      readonly httpStatus: 200;
      readonly reason: string;
    }
  | {
      readonly status: "missing_signature";
      readonly httpStatus: 400;
    }
  | {
      readonly status: "invalid_signature";
      readonly httpStatus: 400;
    };

/**
 * Deterministic delivery id: `fedex-wh:` + SHA-256 hex of the raw
 * body. Stable across FedEx retry redeliveries (same bytes), unique
 * across distinct notifications (any changed scan changes the hash).
 */
export function deriveFedExDeliveryId(rawBody: string | Buffer): string {
  const buffer = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return `fedex-wh:${createHash("sha256").update(buffer).digest("hex")}`;
}

export async function handleFedExWebhook(
  input: HandleFedExWebhookInput,
  deps: HandleFedExWebhookDeps
): Promise<HandleFedExWebhookResult> {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger.child({ component: "fedex.webhook" });

  if (
    input.signatureHeader === null ||
    input.signatureHeader === undefined ||
    input.signatureHeader.length === 0
  ) {
    log.warn("fedex.webhook.missing_signature");
    return { status: "missing_signature", httpStatus: 400 };
  }

  // Misconfigured webhook secret throws from `verifyFedExSignature`
  // and propagates to the HTTP route so it can 503 instead of
  // silently accepting.
  const verification = verifyFedExSignature({
    rawBody: input.rawBody,
    signatureHeader: input.signatureHeader,
    webhookSecret: deps.webhookSecret,
  });

  if (!verification.ok) {
    log.warn("fedex.webhook.invalid_signature", {
      errorName: (verification.error as FedExSignatureError).name,
    });
    return { status: "invalid_signature", httpStatus: 400 };
  }

  const bodyString =
    typeof input.rawBody === "string" ? input.rawBody : input.rawBody.toString("utf8");
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(bodyString);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "JSON parse failed";
    log.warn("fedex.webhook.malformed_body", { reason });
    // 200 so FedEx stops retrying a permanently broken body.
    return { status: "malformed_body", httpStatus: 200, reason };
  }

  let entries: ReturnType<typeof parseFedExWebhookPayload>;
  try {
    entries = parseFedExWebhookPayload(rawJson);
  } catch (cause) {
    if (cause instanceof FedExWebhookPayloadError) {
      log.warn("fedex.webhook.malformed_body", { reason: cause.message });
      return { status: "malformed_body", httpStatus: 200, reason: cause.message };
    }
    throw cause;
  }

  const externalEventId = deriveFedExDeliveryId(input.rawBody);
  const signatureVerifiedAt = clock();
  const stored = projectFedExWebhookForStorage(entries);
  const first = entries[0];

  const { record, inserted } = await deps.eventStore.recordReceived({
    externalEventId,
    eventType: FEDEX_WEBHOOK_EVENT_TYPE,
    trackingNumber: first?.trackingNumber ?? null,
    carrierStatus: first?.trackResult.latestStatusDetail?.code ?? null,
    payload: stored,
    receivedAt: signatureVerifiedAt,
    signatureVerifiedAt,
    initialStatus: "PENDING",
  });

  if (!inserted) {
    log.info("fedex.webhook.duplicate", { externalEventId });
    return { status: "duplicate", httpStatus: 200, externalEventId, record };
  }

  log.info("fedex.webhook.accepted", {
    externalEventId,
    entryCount: entries.length,
  });
  return { status: "accepted", httpStatus: 200, externalEventId, record };
}
