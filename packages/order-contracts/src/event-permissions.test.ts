// Unit tests for the order event-type → permission contract.
//
// Guards the two properties downstream SoD checks rely on: known
// order events translate to their permission, and unmapped/unknown
// event types translate to null (so the bus's SoD helper skips them
// rather than throwing).

import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "@pharmax/rbac";

import { ORDER_EVENT_TYPE_TO_PERMISSION, orderEventTypeToPermission } from "./event-permissions.js";

describe("orderEventTypeToPermission", () => {
  it("maps a known workflow event to its permission", () => {
    expect(orderEventTypeToPermission("order.pv1.approved.v1")).toBe(PERMISSIONS.PV1_APPROVE);
    expect(orderEventTypeToPermission("order.typing.completed.v1")).toBe(
      PERMISSIONS.TYPING_COMPLETE
    );
    expect(orderEventTypeToPermission("order.fill.completed.v1")).toBe(PERMISSIONS.FILL_COMPLETE);
  });

  it("returns null for an unmapped / unknown event type", () => {
    expect(orderEventTypeToPermission("order.note.added.v1")).toBeNull();
    expect(orderEventTypeToPermission("totally.unknown.v1")).toBeNull();
  });

  it("table is frozen (immutable contract)", () => {
    expect(Object.isFrozen(ORDER_EVENT_TYPE_TO_PERMISSION)).toBe(true);
  });
});
