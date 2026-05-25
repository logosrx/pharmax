import { ShipmentStatus, ShipmentTrackingEventKind } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import { normalizeEasyPostStatus, shipmentStatusForTrackingKind } from "./easypost-status.js";

describe("normalizeEasyPostStatus", () => {
  it.each([
    ["pre_transit", ShipmentTrackingEventKind.CREATED],
    ["in_transit", ShipmentTrackingEventKind.IN_TRANSIT],
    ["out_for_delivery", ShipmentTrackingEventKind.OUT_FOR_DELIVERY],
    ["delivered", ShipmentTrackingEventKind.DELIVERED],
    ["return_to_sender", ShipmentTrackingEventKind.RETURN_TO_SENDER],
    ["failure", ShipmentTrackingEventKind.FAILED_DELIVERY],
    ["cancelled", ShipmentTrackingEventKind.EXCEPTION],
    ["error", ShipmentTrackingEventKind.EXCEPTION],
  ])("maps EasyPost status %s → %s", (raw, expected) => {
    expect(normalizeEasyPostStatus(raw)).toBe(expected);
  });

  it("is case-insensitive", () => {
    expect(normalizeEasyPostStatus("DELIVERED")).toBe(ShipmentTrackingEventKind.DELIVERED);
  });

  it("falls back to UNKNOWN for unrecognized values", () => {
    expect(normalizeEasyPostStatus("on_a_unicycle")).toBe(ShipmentTrackingEventKind.UNKNOWN);
  });
});

describe("shipmentStatusForTrackingKind", () => {
  it("returns the matching shipment status for terminal lifecycle kinds", () => {
    expect(shipmentStatusForTrackingKind(ShipmentTrackingEventKind.DELIVERED)).toBe(
      ShipmentStatus.DELIVERED
    );
    expect(shipmentStatusForTrackingKind(ShipmentTrackingEventKind.EXCEPTION)).toBe(
      ShipmentStatus.EXCEPTION
    );
  });

  it("returns null for operational kinds that should not change status", () => {
    expect(shipmentStatusForTrackingKind(ShipmentTrackingEventKind.UNKNOWN)).toBeNull();
    expect(shipmentStatusForTrackingKind(ShipmentTrackingEventKind.CREATED)).toBeNull();
  });
});
