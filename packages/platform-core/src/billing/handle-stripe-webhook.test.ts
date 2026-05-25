import Stripe from "stripe";
import { beforeEach, describe, expect, it } from "vitest";

import { noopLogger } from "../logger/types.js";

import { handleStripeWebhook } from "./handle-stripe-webhook.js";
import { InMemoryStripeWebhookEventStore } from "./in-memory-event-store.js";
import { createStripeWebhookSignatureVerifier } from "./webhook-verifier.js";

const TEST_SECRET = "whsec_handle_stripe_webhook_secret";

function buildStripe(): Stripe {
  // `apiVersion` intentionally omitted; see webhook-verifier.test.ts.
  return new Stripe("sk_test_dummy_for_unit_tests");
}

interface BuildSignedOptions {
  eventId?: string;
  eventType?: string;
  secret?: string;
}

function buildSigned(options: BuildSignedOptions = {}) {
  const stripe = buildStripe();
  const eventId = options.eventId ?? "evt_handle_1";
  const eventType = options.eventType ?? "invoice.paid";
  const secret = options.secret ?? TEST_SECRET;
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    type: eventType,
    api_version: null,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "in_test_1", object: "invoice" } },
    request: { id: null, idempotency_key: null },
  });
  const signatureHeader = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  return { stripe, payload, signatureHeader };
}

describe("handleStripeWebhook", () => {
  let eventStore: InMemoryStripeWebhookEventStore;

  beforeEach(() => {
    eventStore = new InMemoryStripeWebhookEventStore();
  });

  it("returns missing_signature when the header is absent", async () => {
    const { stripe, payload } = buildSigned();
    const result = await handleStripeWebhook(
      { rawBody: payload, signatureHeader: null },
      {
        verifier: createStripeWebhookSignatureVerifier(stripe),
        eventStore,
        webhookSecret: TEST_SECRET,
        logger: noopLogger,
      }
    );

    expect(result.status).toBe("missing_signature");
    expect(result.httpStatus).toBe(400);
  });

  it("returns invalid_signature when the secret does not match", async () => {
    const { stripe, payload, signatureHeader } = buildSigned({
      secret: "whsec_wrong",
    });
    const result = await handleStripeWebhook(
      { rawBody: payload, signatureHeader },
      {
        verifier: createStripeWebhookSignatureVerifier(stripe),
        eventStore,
        webhookSecret: TEST_SECRET,
        logger: noopLogger,
      }
    );

    expect(result.status).toBe("invalid_signature");
    expect(result.httpStatus).toBe(400);
  });

  it("accepts a supported event and writes a PENDING ledger row", async () => {
    const { stripe, payload, signatureHeader } = buildSigned();
    const result = await handleStripeWebhook(
      { rawBody: payload, signatureHeader },
      {
        verifier: createStripeWebhookSignatureVerifier(stripe),
        eventStore,
        webhookSecret: TEST_SECRET,
        logger: noopLogger,
      }
    );

    expect(result.status).toBe("accepted");
    expect(result.httpStatus).toBe(200);
    if (result.status === "accepted") {
      expect(result.record.status).toBe("PENDING");
      expect(result.record.attempts).toBe(0);
      expect(result.record.eventType).toBe("invoice.paid");
    }
  });

  it("returns duplicate on a redelivered event and does not advance state", async () => {
    const { stripe, payload, signatureHeader } = buildSigned({ eventId: "evt_dup_1" });
    const deps = {
      verifier: createStripeWebhookSignatureVerifier(stripe),
      eventStore,
      webhookSecret: TEST_SECRET,
      logger: noopLogger,
    };

    const first = await handleStripeWebhook({ rawBody: payload, signatureHeader }, deps);
    const second = await handleStripeWebhook({ rawBody: payload, signatureHeader }, deps);

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("duplicate");
    if (second.status === "duplicate" && first.status === "accepted") {
      expect(second.record.id).toBe(first.record.id);
      expect(second.record.status).toBe("PENDING");
      expect(second.record.attempts).toBe(0);
    }
  });

  it("marks unsupported event types as ignored on first delivery", async () => {
    const { stripe, payload, signatureHeader } = buildSigned({
      eventId: "evt_ignored_1",
      eventType: "charge.succeeded",
    });

    const result = await handleStripeWebhook(
      { rawBody: payload, signatureHeader },
      {
        verifier: createStripeWebhookSignatureVerifier(stripe),
        eventStore,
        webhookSecret: TEST_SECRET,
        logger: noopLogger,
      }
    );

    expect(result.status).toBe("ignored");
    expect(result.httpStatus).toBe(200);
    if (result.status === "ignored") {
      expect(result.record.status).toBe("IGNORED");
      expect(result.record.processedAt).not.toBeNull();
    }
  });
});
