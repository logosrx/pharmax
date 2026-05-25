import { ShipmentTrackingEventKind } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import { isUpsTrackingNumber, normalizeUpsStatus } from "./ups-status.js";

describe("normalizeUpsStatus", () => {
  it.each<[string, ShipmentTrackingEventKind]>([
    ["M", ShipmentTrackingEventKind.CREATED],
    ["MV", ShipmentTrackingEventKind.CREATED],
    ["I", ShipmentTrackingEventKind.IN_TRANSIT],
    ["P", ShipmentTrackingEventKind.IN_TRANSIT],
    ["O", ShipmentTrackingEventKind.OUT_FOR_DELIVERY],
    ["D", ShipmentTrackingEventKind.DELIVERED],
    ["RS", ShipmentTrackingEventKind.RETURN_TO_SENDER],
    ["X", ShipmentTrackingEventKind.EXCEPTION],
    ["NA", ShipmentTrackingEventKind.EXCEPTION],
  ])("maps UPS code %s → %s", (code, expected) => {
    expect(normalizeUpsStatus(code)).toBe(expected);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeUpsStatus("  d  ")).toBe(ShipmentTrackingEventKind.DELIVERED);
  });

  it("returns UNKNOWN for unrecognized codes and falsy input", () => {
    expect(normalizeUpsStatus("ZZ")).toBe(ShipmentTrackingEventKind.UNKNOWN);
    expect(normalizeUpsStatus("")).toBe(ShipmentTrackingEventKind.UNKNOWN);
    expect(normalizeUpsStatus(null)).toBe(ShipmentTrackingEventKind.UNKNOWN);
    expect(normalizeUpsStatus(undefined)).toBe(ShipmentTrackingEventKind.UNKNOWN);
  });
});

describe("isUpsTrackingNumber", () => {
  it.each(["1Z999AA10123456784", "1Z12345E1512345676", "1zABCDEFGHIJ123456".toUpperCase()])(
    "accepts canonical 1Z tracking numbers (%s)",
    (value) => {
      expect(isUpsTrackingNumber(value)).toBe(true);
    }
  );

  it("is case-insensitive and trims whitespace", () => {
    expect(isUpsTrackingNumber("  1z999aa10123456784  ")).toBe(true);
  });

  it.each([
    "",
    "1Z",
    "1Z999AA10123456", // too short
    "1Z999AA101234567890", // too long
    "2Z999AA10123456784", // wrong prefix
    "9400111899223344556677", // USPS shape, not UPS
  ])("rejects non-canonical numbers (%s)", (value) => {
    expect(isUpsTrackingNumber(value)).toBe(false);
  });
});
