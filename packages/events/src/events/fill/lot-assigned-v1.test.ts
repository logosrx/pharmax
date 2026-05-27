// Schema tests for fill.lot.assigned.v1.

import { describe, expect, it } from "vitest";

import { validateAgainst } from "../../define-event.js";
import { FillLotAssignedV1 } from "./lot-assigned-v1.js";

const HAPPY: Record<string, unknown> = Object.freeze({
  organizationId: "00000000-0000-4000-8000-000000000001",
  orderId: "00000000-0000-4000-8000-000000000002",
  orderLineId: "00000000-0000-4000-8000-000000000003",
  lotId: "00000000-0000-4000-8000-000000000004",
  lotAssignmentId: "00000000-0000-4000-8000-000000000005",
  occurredAt: "2026-05-25T10:00:00.000Z",
});

describe("FillLotAssignedV1 schema", () => {
  it("accepts a well-formed payload", () => {
    expect(validateAgainst(FillLotAssignedV1, HAPPY).ok).toBe(true);
  });

  it("rejects a missing lotAssignmentId", () => {
    const partial: Record<string, unknown> = { ...HAPPY };
    delete partial["lotAssignmentId"];
    expect(validateAgainst(FillLotAssignedV1, partial).ok).toBe(false);
  });

  it("aggregateIdFrom selects orderLineId", () => {
    expect(FillLotAssignedV1.aggregateIdFrom(HAPPY as never)).toBe(HAPPY.orderLineId);
  });
});
