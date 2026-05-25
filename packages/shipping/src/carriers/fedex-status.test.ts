import { ShipmentTrackingEventKind } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import { isFedExTrackingNumber, normalizeFedExStatus } from "./fedex-status.js";

describe("normalizeFedExStatus", () => {
  it.each<[string, ShipmentTrackingEventKind]>([
    ["OC", ShipmentTrackingEventKind.CREATED],
    ["OF", ShipmentTrackingEventKind.CREATED],
    ["PU", ShipmentTrackingEventKind.IN_TRANSIT],
    ["IT", ShipmentTrackingEventKind.IN_TRANSIT],
    ["AR", ShipmentTrackingEventKind.IN_TRANSIT],
    ["OD", ShipmentTrackingEventKind.OUT_FOR_DELIVERY],
    ["HL", ShipmentTrackingEventKind.OUT_FOR_DELIVERY],
    ["DL", ShipmentTrackingEventKind.DELIVERED],
    ["RS", ShipmentTrackingEventKind.RETURN_TO_SENDER],
    ["RP", ShipmentTrackingEventKind.RETURN_TO_SENDER],
    ["CA", ShipmentTrackingEventKind.EXCEPTION],
    ["DE", ShipmentTrackingEventKind.EXCEPTION],
    ["SE", ShipmentTrackingEventKind.EXCEPTION],
  ])("maps FedEx code %s → %s", (code, expected) => {
    expect(normalizeFedExStatus(code)).toBe(expected);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeFedExStatus("  dl  ")).toBe(ShipmentTrackingEventKind.DELIVERED);
  });

  it("returns UNKNOWN for unrecognized codes and falsy input", () => {
    expect(normalizeFedExStatus("ZZ")).toBe(ShipmentTrackingEventKind.UNKNOWN);
    expect(normalizeFedExStatus("")).toBe(ShipmentTrackingEventKind.UNKNOWN);
    expect(normalizeFedExStatus(null)).toBe(ShipmentTrackingEventKind.UNKNOWN);
    expect(normalizeFedExStatus(undefined)).toBe(ShipmentTrackingEventKind.UNKNOWN);
  });
});

describe("isFedExTrackingNumber", () => {
  it.each(["123456789012", "123456789012345", "12345678901234567890", "1234567890123456789012"])(
    "accepts %s (valid FedEx length)",
    (tn) => expect(isFedExTrackingNumber(tn)).toBe(true)
  );

  // Note: a 22-digit USPS tracking number shares the same numeric
  // shape as FedEx's 22-digit format, so shape alone can't reject
  // it — distinguishing requires the carrier hint on the shipment
  // row. The predicate is for "candidate filtering" only.
  it.each(["1Z9999999999999999", "abc", "1234"])("rejects %s (not a FedEx shape)", (tn) =>
    expect(isFedExTrackingNumber(tn)).toBe(false)
  );
});
