import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { StripeSignatureError, StripeWebhookConfigError } from "./errors.js";
import { createStripeWebhookSignatureVerifier } from "./webhook-verifier.js";

const TEST_SECRET = "whsec_test_secret_for_unit_tests";
const ALT_SECRET = "whsec_alternate_secret";

function buildStripe(): Stripe {
  // Dummy API key — constructEvent/constructEventAsync never make network calls.
  // `apiVersion` intentionally omitted so the SDK's default is used and this
  // file does not need to be touched on every Stripe API version bump.
  return new Stripe("sk_test_dummy_for_unit_tests");
}

function buildSignedPayload(secret: string, eventId = "evt_test_1") {
  const stripe = buildStripe();
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    type: "invoice.paid",
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

describe("createStripeWebhookSignatureVerifier", () => {
  it("verifies a signature minted with the configured secret", async () => {
    const { stripe, payload, signatureHeader } = buildSignedPayload(TEST_SECRET);
    const verifier = createStripeWebhookSignatureVerifier(stripe);

    const result = await verifier.verify({
      rawBody: payload,
      signatureHeader,
      webhookSecret: TEST_SECRET,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.id).toBe("evt_test_1");
      expect(result.event.type).toBe("invoice.paid");
    }
  });

  it("rejects a signature minted with a different secret", async () => {
    const { stripe, payload, signatureHeader } = buildSignedPayload(ALT_SECRET);
    const verifier = createStripeWebhookSignatureVerifier(stripe);

    const result = await verifier.verify({
      rawBody: payload,
      signatureHeader,
      webhookSecret: TEST_SECRET,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(StripeSignatureError);
      expect(result.error.code).toBe("BILLING_STRIPE_SIGNATURE_INVALID");
      expect(result.error.message).not.toContain(payload);
    }
  });

  it("rejects when the raw body is tampered with", async () => {
    const { stripe, payload, signatureHeader } = buildSignedPayload(TEST_SECRET);
    const verifier = createStripeWebhookSignatureVerifier(stripe);

    const result = await verifier.verify({
      rawBody: `${payload} `,
      signatureHeader,
      webhookSecret: TEST_SECRET,
    });

    expect(result.ok).toBe(false);
  });

  it("rejects when the signature header is empty", async () => {
    const { stripe, payload } = buildSignedPayload(TEST_SECRET);
    const verifier = createStripeWebhookSignatureVerifier(stripe);

    const result = await verifier.verify({
      rawBody: payload,
      signatureHeader: "",
      webhookSecret: TEST_SECRET,
    });

    expect(result.ok).toBe(false);
  });

  it("throws a config error when the webhook secret is empty", async () => {
    const { stripe, payload, signatureHeader } = buildSignedPayload(TEST_SECRET);
    const verifier = createStripeWebhookSignatureVerifier(stripe);

    await expect(
      verifier.verify({
        rawBody: payload,
        signatureHeader,
        webhookSecret: "",
      })
    ).rejects.toBeInstanceOf(StripeWebhookConfigError);
  });
});
