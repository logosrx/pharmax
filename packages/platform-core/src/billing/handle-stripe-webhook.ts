// End-to-end Stripe webhook entry point.
//
// Responsibilities (in order):
//   1. Verify the signature against the configured webhook secret.
//   2. Record the event idempotently in `stripe_webhook_event`.
//   3. Return a typed result the transport adapter can map to an HTTP
//      response (200 for accepted/duplicate/ignored, 400 for signature,
//      malformed, or missing-header errors).
//
// The handler DOES NOT run domain side effects. A worker drains rows in
// PENDING status and calls `processStripeWebhookEvent`, which invokes the
// dispatcher. This split is required because:
//   - Stripe expects 2xx within a few seconds; long handlers risk retries.
//   - Webhook processing must survive process restarts; the ledger row is
//     the durable hand-off between the transport edge and the worker.
//   - Replays land in the same persisted row with `attempts` bumped, never
//     a second domain side effect.

import type Stripe from "stripe";

import type { Logger } from "../logger/types.js";

import type { StripeWebhookEventRecord, StripeWebhookEventStore } from "./event-store.js";
import { isSupportedStripeEventType } from "./stripe-events.js";
import type {
  StripeWebhookSignatureVerifier,
  VerifyStripeSignatureInput,
} from "./webhook-verifier.js";

export interface HandleStripeWebhookDeps {
  readonly verifier: StripeWebhookSignatureVerifier;
  readonly eventStore: StripeWebhookEventStore;
  readonly webhookSecret: string;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly toleranceSeconds?: number;
}

export interface HandleStripeWebhookInput {
  readonly rawBody: string | Buffer;
  readonly signatureHeader: string | null | undefined;
}

export type HandleStripeWebhookResult =
  | {
      readonly status: "accepted";
      readonly httpStatus: 200;
      readonly stripeEventId: string;
      readonly eventType: string;
      readonly record: StripeWebhookEventRecord;
    }
  | {
      readonly status: "duplicate";
      readonly httpStatus: 200;
      readonly stripeEventId: string;
      readonly eventType: string;
      readonly record: StripeWebhookEventRecord;
    }
  | {
      readonly status: "ignored";
      readonly httpStatus: 200;
      readonly stripeEventId: string;
      readonly eventType: string;
      readonly record: StripeWebhookEventRecord;
    }
  | {
      readonly status: "missing_signature";
      readonly httpStatus: 400;
    }
  | {
      readonly status: "invalid_signature";
      readonly httpStatus: 400;
    };

export async function handleStripeWebhook(
  input: HandleStripeWebhookInput,
  deps: HandleStripeWebhookDeps
): Promise<HandleStripeWebhookResult> {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger.child({ component: "stripe.webhook" });

  if (
    input.signatureHeader === null ||
    input.signatureHeader === undefined ||
    input.signatureHeader.length === 0
  ) {
    log.warn("stripe.webhook.missing_signature");
    return { status: "missing_signature", httpStatus: 400 };
  }

  const verifyInput: VerifyStripeSignatureInput = {
    rawBody: input.rawBody,
    signatureHeader: input.signatureHeader,
    webhookSecret: deps.webhookSecret,
    ...(deps.toleranceSeconds === undefined ? {} : { toleranceSeconds: deps.toleranceSeconds }),
  };

  const verification = await deps.verifier.verify(verifyInput);

  if (!verification.ok) {
    log.warn("stripe.webhook.invalid_signature", {
      errorCode: verification.error.code,
    });
    return { status: "invalid_signature", httpStatus: 400 };
  }

  const event: Stripe.Event = verification.event;
  const signatureVerifiedAt = clock();
  const initialStatus = isSupportedStripeEventType(event.type) ? "PENDING" : "IGNORED";

  const { record, inserted } = await deps.eventStore.recordReceived({
    event,
    receivedAt: signatureVerifiedAt,
    signatureVerifiedAt,
    initialStatus,
  });

  if (!inserted) {
    log.info("stripe.webhook.duplicate", {
      stripeEventId: event.id,
      eventType: event.type,
    });
    return {
      status: "duplicate",
      httpStatus: 200,
      stripeEventId: event.id,
      eventType: event.type,
      record,
    };
  }

  if (initialStatus === "IGNORED") {
    log.info("stripe.webhook.ignored", {
      stripeEventId: event.id,
      eventType: event.type,
    });
    return {
      status: "ignored",
      httpStatus: 200,
      stripeEventId: event.id,
      eventType: event.type,
      record,
    };
  }

  log.info("stripe.webhook.accepted", {
    stripeEventId: event.id,
    eventType: event.type,
  });

  return {
    status: "accepted",
    httpStatus: 200,
    stripeEventId: event.id,
    eventType: event.type,
    record,
  };
}
