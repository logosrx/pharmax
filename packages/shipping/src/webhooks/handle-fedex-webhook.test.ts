import { createHmac } from "node:crypto";

import { logger as loggerNs } from "@pharmax/platform-core";
import { beforeEach, describe, expect, it } from "vitest";

import { deriveFedExDeliveryId, handleFedExWebhook } from "./handle-fedex-webhook.js";
import { InMemoryFedExWebhookEventStore } from "./in-memory-fedex-event-store.js";

const SECRET = "portal-security-token";
const NOW = new Date("2026-07-21T16:00:00.000Z");

const VALID_BODY = JSON.stringify({
  trackResults: [
    {
      trackingNumber: "794665654567",
      latestStatusDetail: { code: "IT", statusByLocale: "In transit" },
      scanEvents: [
        {
          date: "2026-07-21T08:00:00-04:00",
          eventType: "AR",
          derivedStatusCode: "IT",
          scanLocation: { city: "MEMPHIS", stateOrProvinceCode: "TN", countryCode: "US" },
        },
      ],
    },
  ],
});

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("base64");
}

describe("handleFedExWebhook", () => {
  let eventStore: InMemoryFedExWebhookEventStore;

  beforeEach(() => {
    eventStore = new InMemoryFedExWebhookEventStore();
  });

  function deps() {
    return {
      eventStore,
      webhookSecret: SECRET,
      logger: loggerNs.noopLogger,
      clock: () => NOW,
    };
  }

  it("accepts a valid signed delivery and persists it as PENDING", async () => {
    const result = await handleFedExWebhook(
      { rawBody: VALID_BODY, signatureHeader: sign(VALID_BODY) },
      deps()
    );

    expect(result.status).toBe("accepted");
    expect(result.httpStatus).toBe(200);
    if (result.status === "accepted") {
      expect(result.externalEventId).toBe(deriveFedExDeliveryId(VALID_BODY));
      expect(result.record.status).toBe("PENDING");
      expect(result.record.trackingNumber).toBe("794665654567");
      expect(result.record.carrierStatus).toBe("IT");
      // Stored payload is the PHI-minimized projection.
      expect(result.record.payload.entries).toHaveLength(1);
    }
  });

  it("acks a redelivery of the same bytes as duplicate without a second row", async () => {
    await handleFedExWebhook({ rawBody: VALID_BODY, signatureHeader: sign(VALID_BODY) }, deps());
    const second = await handleFedExWebhook(
      { rawBody: VALID_BODY, signatureHeader: sign(VALID_BODY) },
      deps()
    );

    expect(second.status).toBe("duplicate");
    expect(second.httpStatus).toBe(200);
  });

  it("returns 400 missing_signature when the header is absent", async () => {
    const result = await handleFedExWebhook({ rawBody: VALID_BODY, signatureHeader: null }, deps());
    expect(result).toEqual({ status: "missing_signature", httpStatus: 400 });
  });

  it("returns 400 invalid_signature for a bad HMAC and persists nothing", async () => {
    const result = await handleFedExWebhook(
      { rawBody: VALID_BODY, signatureHeader: sign("different-bytes") },
      deps()
    );
    expect(result).toEqual({ status: "invalid_signature", httpStatus: 400 });
    expect(await eventStore.findByExternalEventId(deriveFedExDeliveryId(VALID_BODY))).toBeNull();
  });

  it("acks non-JSON bodies 200 malformed_body so FedEx stops retrying", async () => {
    const body = "this is not json";
    const result = await handleFedExWebhook({ rawBody: body, signatureHeader: sign(body) }, deps());
    expect(result.status).toBe("malformed_body");
    expect(result.httpStatus).toBe(200);
  });

  it("acks an unrecognized envelope 200 malformed_body", async () => {
    const body = JSON.stringify({ unexpected: true });
    const result = await handleFedExWebhook({ rawBody: body, signatureHeader: sign(body) }, deps());
    expect(result.status).toBe("malformed_body");
    expect(result.httpStatus).toBe(200);
  });
});
