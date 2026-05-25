import { describe, expect, it } from "vitest";

import { EasyPostPayloadError, parseEasyPostTrackerWebhook } from "./easypost-payload.js";

describe("parseEasyPostTrackerWebhook", () => {
  it("parses a tracker.updated payload", () => {
    const payload = {
      id: "evt_abc",
      description: "tracker.updated",
      result: {
        id: "trk_xyz",
        tracking_code: "9400111899223344556677",
        status: "in_transit",
        status_detail: "arrived_at_facility",
        updated_at: "2026-05-24T18:00:00Z",
        carrier: "USPS",
      },
    };
    const parsed = parseEasyPostTrackerWebhook(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.result.tracking_code).toBe("9400111899223344556677");
    expect(parsed!.result.status).toBe("in_transit");
  });

  it("returns null for non-tracker events", () => {
    const parsed = parseEasyPostTrackerWebhook({
      id: "evt_abc",
      description: "scan_form.created",
      result: {},
    });
    expect(parsed).toBeNull();
  });

  it("throws on missing required fields", () => {
    expect(() =>
      parseEasyPostTrackerWebhook({
        id: "evt_abc",
        description: "tracker.updated",
        result: { id: "trk_xyz" },
      })
    ).toThrow(EasyPostPayloadError);
  });

  it("throws on non-object input", () => {
    expect(() => parseEasyPostTrackerWebhook("nope")).toThrow(EasyPostPayloadError);
    expect(() => parseEasyPostTrackerWebhook(null)).toThrow(EasyPostPayloadError);
  });
});
