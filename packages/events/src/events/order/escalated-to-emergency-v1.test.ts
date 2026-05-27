// Schema tests for order.escalated_to_emergency.v1.
//
// This event drives a downstream notification + dashboard counter
// and is produced inside the EscalateOrderToEmergencyBucket
// command. The schema test pins the contract — happy-path
// validation succeeds, malformed inputs (wrong types, missing
// required fields, PHI-shaped fields) are rejected.

import { describe, expect, it } from "vitest";

import { validateAgainst } from "../../define-event.js";
import { OrderEscalatedToEmergencyV1 } from "./escalated-to-emergency-v1.js";

const HAPPY: Record<string, unknown> = Object.freeze({
  orderId: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  shipmentId: "00000000-0000-4000-8000-000000000003",
  trackingEventId: "00000000-0000-4000-8000-000000000004",
  externalEventId: "evt_abc123",
  reason: "EXCEPTION",
  carrierStatus: "delivery_exception",
  previousBucketId: "00000000-0000-4000-8000-000000000005",
  newBucketId: "00000000-0000-4000-8000-000000000006",
  occurredAt: "2026-05-25T10:00:00.000Z",
});

describe("OrderEscalatedToEmergencyV1 schema", () => {
  it("accepts a well-formed payload", () => {
    const result = validateAgainst(OrderEscalatedToEmergencyV1, HAPPY);
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid UUID on orderId", () => {
    const result = validateAgainst(OrderEscalatedToEmergencyV1, {
      ...HAPPY,
      orderId: "not-a-uuid",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown escalation reason", () => {
    const result = validateAgainst(OrderEscalatedToEmergencyV1, {
      ...HAPPY,
      reason: "NOT_A_VALID_REASON",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects missing externalEventId", () => {
    const partial: Record<string, unknown> = { ...HAPPY };
    delete partial["externalEventId"];
    const result = validateAgainst(OrderEscalatedToEmergencyV1, partial);
    expect(result.ok).toBe(false);
  });

  it("rejects extra (PHI-shaped) fields under strict mode", () => {
    const result = validateAgainst(OrderEscalatedToEmergencyV1, {
      ...HAPPY,
      // PHI-shaped field name — strict schema should refuse it.
      patientFirstName: "Sample",
    });
    expect(result.ok).toBe(false);
  });

  it("aggregateIdFrom selects orderId", () => {
    expect(OrderEscalatedToEmergencyV1.aggregateIdFrom(HAPPY as never)).toBe(HAPPY.orderId);
  });
});
