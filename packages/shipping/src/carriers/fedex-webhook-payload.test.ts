import { describe, expect, it } from "vitest";

import {
  FedExWebhookPayloadError,
  parseFedExWebhookPayload,
  projectFedExWebhookForStorage,
} from "./fedex-webhook-payload.js";

const SCAN = {
  date: "2026-07-21T08:00:00-04:00",
  eventType: "AR",
  eventDescription: "Arrived at FedEx hub",
  derivedStatusCode: "IT",
  scanLocation: { city: "MEMPHIS", stateOrProvinceCode: "TN", countryCode: "US" },
};

describe("parseFedExWebhookPayload — envelopes", () => {
  it("parses the flat { trackResults: [...] } envelope", () => {
    const entries = parseFedExWebhookPayload({
      trackResults: [{ trackingNumber: "794665654567", scanEvents: [SCAN] }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.trackingNumber).toBe("794665654567");
    expect(entries[0]!.trackResult.scanEvents).toHaveLength(1);
  });

  it("parses the nested { output: { completeTrackResults: [...] } } envelope", () => {
    const entries = parseFedExWebhookPayload({
      output: {
        completeTrackResults: [
          {
            trackingNumber: "794665654567",
            trackResults: [{ scanEvents: [SCAN] }],
          },
        ],
      },
    });
    expect(entries).toHaveLength(1);
    // Tracking number inherited from the completeTrackResults wrapper.
    expect(entries[0]!.trackingNumber).toBe("794665654567");
  });

  it("tolerates unknown extra fields (loose parsing)", () => {
    const entries = parseFedExWebhookPayload({
      trackResults: [
        {
          trackingNumber: "794665654567",
          scanEvents: [{ ...SCAN, futureField: { nested: true } }],
          somethingFedExAddsNextYear: 42,
        },
      ],
      notificationEventType: "TRACK_UPDATE",
    });
    expect(entries).toHaveLength(1);
  });

  it("throws FedExWebhookPayloadError for an unrecognized envelope", () => {
    expect(() => parseFedExWebhookPayload({ hello: "world" })).toThrow(FedExWebhookPayloadError);
  });

  it("throws when no entry carries a tracking number", () => {
    expect(() => parseFedExWebhookPayload({ trackResults: [{ scanEvents: [SCAN] }] })).toThrow(
      FedExWebhookPayloadError
    );
  });
});

describe("projectFedExWebhookForStorage — PHI stripping", () => {
  it("keeps replay fields and drops shipper/recipient PII", () => {
    const entries = parseFedExWebhookPayload({
      trackResults: [
        {
          trackingNumber: "794665654567",
          latestStatusDetail: { code: "IT", statusByLocale: "In transit" },
          dateAndTimes: [{ type: "ESTIMATED_DELIVERY", dateTime: "2026-07-23T20:00:00-04:00" }],
          scanEvents: [SCAN],
          // PII an account-number AIV subscription can include —
          // synthetic values only, per the no-real-PHI rule.
          recipientInformation: {
            contact: { personName: "Test Patient", phoneNumber: "5555550100" },
            address: { streetLines: ["123 Synthetic Way"], city: "AUSTIN" },
          },
          shipperInformation: {
            contact: { personName: "Test Pharmacy" },
          },
        },
      ],
    });

    const stored = projectFedExWebhookForStorage(entries);
    const json = JSON.stringify(stored);

    // Replay subset survives.
    expect(stored.entries[0]!.trackingNumber).toBe("794665654567");
    expect(stored.entries[0]!.trackResult.latestStatusDetail?.code).toBe("IT");
    expect(stored.entries[0]!.trackResult.dateAndTimes?.[0]?.type).toBe("ESTIMATED_DELIVERY");
    expect(stored.entries[0]!.trackResult.scanEvents?.[0]?.scanLocation?.city).toBe("MEMPHIS");

    // PII does not.
    expect(json).not.toContain("Test Patient");
    expect(json).not.toContain("Synthetic Way");
    expect(json).not.toContain("5555550100");
    expect(json).not.toContain("recipientInformation");
    expect(json).not.toContain("shipperInformation");
  });
});
