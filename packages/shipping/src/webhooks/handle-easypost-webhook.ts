// End-to-end EasyPost webhook entry point.
//
// Responsibilities, in order:
//   1. Verify the signature against the configured webhook secret.
//   2. Parse the body. Non-tracker events are persisted as IGNORED so
//      EasyPost stops retrying; tracker events are persisted as PENDING.
//   3. Record the event idempotently in `easypost_webhook_event`.
//   4. Return a typed result the transport adapter can map to an HTTP
//      response (200 for accepted/duplicate/ignored/malformed-body,
//      400 for signature / missing-header errors).
//
// The handler DOES NOT run domain side effects. A worker drains rows
// in PENDING status and calls `processEasyPostWebhookEvent`, which
// looks up the shipment, enters tenancy, and executes
// `RecordShipmentTrackingEvent`. This split mirrors the Stripe
// pipeline and is required because:
//   - EasyPost expects 2xx within seconds; long handlers risk retries.
//   - Webhook processing must survive process restarts; the ledger row
//     is the durable hand-off between the transport edge and the worker.
//   - Replays land in the same persisted row with `attempts` bumped,
//     never a second domain side effect.

import type { logger as loggerContract } from "@pharmax/platform-core";

import {
  EASYPOST_TRACKER_EVENT_DESCRIPTIONS,
  EasyPostPayloadError,
  parseEasyPostTrackerWebhook,
  type EasyPostTrackerWebhookPayload,
} from "../carriers/easypost-payload.js";
import { verifyEasyPostSignature } from "../carriers/easypost-signature.js";
import type { EasyPostSignatureError } from "../carriers/easypost-signature.js";

import type { EasyPostWebhookEventRecord, EasyPostWebhookEventStore } from "./event-store.js";

type Logger = loggerContract.Logger;

export interface HandleEasyPostWebhookDeps {
  readonly eventStore: EasyPostWebhookEventStore;
  readonly webhookSecret: string;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

export interface HandleEasyPostWebhookInput {
  readonly rawBody: string | Buffer;
  readonly signatureHeader: string | null | undefined;
}

export type HandleEasyPostWebhookResult =
  | {
      readonly status: "accepted";
      readonly httpStatus: 200;
      readonly externalEventId: string;
      readonly eventType: string;
      readonly record: EasyPostWebhookEventRecord;
    }
  | {
      readonly status: "duplicate";
      readonly httpStatus: 200;
      readonly externalEventId: string;
      readonly eventType: string;
      readonly record: EasyPostWebhookEventRecord;
    }
  | {
      readonly status: "ignored";
      readonly httpStatus: 200;
      readonly externalEventId: string;
      readonly eventType: string;
      readonly record: EasyPostWebhookEventRecord;
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

function isTrackerEvent(description: string): boolean {
  return (EASYPOST_TRACKER_EVENT_DESCRIPTIONS as ReadonlyArray<string>).includes(description);
}

export async function handleEasyPostWebhook(
  input: HandleEasyPostWebhookInput,
  deps: HandleEasyPostWebhookDeps
): Promise<HandleEasyPostWebhookResult> {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger.child({ component: "easypost.webhook" });

  if (
    input.signatureHeader === null ||
    input.signatureHeader === undefined ||
    input.signatureHeader.length === 0
  ) {
    log.warn("easypost.webhook.missing_signature");
    return { status: "missing_signature", httpStatus: 400 };
  }

  // Programmer-error path: misconfigured webhook secret is thrown
  // from `verifyEasyPostSignature` and propagates to the HTTP route
  // so it can return a 503 instead of silently accepting.
  const verification = verifyEasyPostSignature({
    rawBody: input.rawBody,
    signatureHeader: input.signatureHeader,
    webhookSecret: deps.webhookSecret,
  });

  if (!verification.ok) {
    log.warn("easypost.webhook.invalid_signature", {
      errorName: (verification.error as EasyPostSignatureError).name,
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
    log.warn("easypost.webhook.malformed_body", { reason });
    // Return 200 so EasyPost stops retrying a permanently broken body.
    return { status: "malformed_body", httpStatus: 200, reason };
  }

  // Pull description up front so we can decide between IGNORED (non-
  // tracker) and PENDING (tracker) before strict parsing happens.
  const description = (rawJson as { description?: unknown }).description;
  if (typeof description !== "string" || description.length === 0) {
    log.warn("easypost.webhook.malformed_body", { reason: "missing description" });
    return { status: "malformed_body", httpStatus: 200, reason: "missing description" };
  }

  if (!isTrackerEvent(description)) {
    // Non-tracker event (scan_form.created, batch.created, etc.). We
    // don't currently ingest these, but persist them as IGNORED so the
    // operator can see them in the inbox and EasyPost stops retrying.
    // Build a minimal synthetic payload so the in-memory store has
    // something with the required shape.
    const externalEventId = (rawJson as { id?: unknown }).id;
    if (typeof externalEventId !== "string" || externalEventId.length === 0) {
      log.warn("easypost.webhook.malformed_body", { reason: "missing id" });
      return { status: "malformed_body", httpStatus: 200, reason: "missing id" };
    }
    const ignoredPayload = {
      id: externalEventId,
      description: "tracker.updated" as const,
      result: {
        id: "ignored",
        tracking_code: "",
        status: description,
        updated_at: new Date(0).toISOString(),
      },
    } satisfies EasyPostTrackerWebhookPayload;

    const signatureVerifiedAt = clock();
    const { record, inserted } = await deps.eventStore.recordReceived({
      event: ignoredPayload,
      receivedAt: signatureVerifiedAt,
      signatureVerifiedAt,
      initialStatus: "IGNORED",
    });
    log.info(inserted ? "easypost.webhook.ignored" : "easypost.webhook.duplicate", {
      externalEventId,
      eventType: description,
    });
    return {
      status: inserted ? "ignored" : "duplicate",
      httpStatus: 200,
      externalEventId,
      eventType: description,
      record,
    };
  }

  let payload: EasyPostTrackerWebhookPayload | null;
  try {
    payload = parseEasyPostTrackerWebhook(rawJson);
  } catch (cause) {
    if (cause instanceof EasyPostPayloadError) {
      log.warn("easypost.webhook.malformed_body", { reason: cause.message });
      return { status: "malformed_body", httpStatus: 200, reason: cause.message };
    }
    throw cause;
  }
  if (payload === null) {
    // parseEasyPostTrackerWebhook returned null only for non-tracker
    // descriptions; we already handled that branch above.
    log.warn("easypost.webhook.malformed_body", { reason: "non-tracker event" });
    return { status: "malformed_body", httpStatus: 200, reason: "non-tracker event" };
  }

  const signatureVerifiedAt = clock();
  const { record, inserted } = await deps.eventStore.recordReceived({
    event: payload,
    receivedAt: signatureVerifiedAt,
    signatureVerifiedAt,
    initialStatus: "PENDING",
  });

  if (!inserted) {
    log.info("easypost.webhook.duplicate", {
      externalEventId: payload.id,
      eventType: payload.description,
    });
    return {
      status: "duplicate",
      httpStatus: 200,
      externalEventId: payload.id,
      eventType: payload.description,
      record,
    };
  }

  log.info("easypost.webhook.accepted", {
    externalEventId: payload.id,
    eventType: payload.description,
    trackingCode: payload.result.tracking_code,
  });

  return {
    status: "accepted",
    httpStatus: 200,
    externalEventId: payload.id,
    eventType: payload.description,
    record,
  };
}
