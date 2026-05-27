// Schema tests for order.typing.started.v1.

import { describe, expect, it } from "vitest";

import { validateAgainst } from "../../define-event.js";
import { OrderTypingStartedV1 } from "./typing-started-v1.js";

const HAPPY: Record<string, unknown> = Object.freeze({
  orderId: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  siteId: "00000000-0000-4000-8000-000000000003",
  typistUserId: "00000000-0000-4000-8000-000000000004",
  bucketId: "00000000-0000-4000-8000-000000000005",
  transitionId: "wf.v1.start_typing",
  fromState: "RECEIVED",
  toState: "TYPING_IN_PROGRESS",
  occurredAt: "2026-05-25T10:00:00.000Z",
});

describe("OrderTypingStartedV1 schema", () => {
  it("accepts a well-formed payload", () => {
    expect(validateAgainst(OrderTypingStartedV1, HAPPY).ok).toBe(true);
  });

  it("rejects an empty transitionId", () => {
    expect(validateAgainst(OrderTypingStartedV1, { ...HAPPY, transitionId: "" }).ok).toBe(false);
  });

  it("rejects a non-ISO occurredAt", () => {
    expect(validateAgainst(OrderTypingStartedV1, { ...HAPPY, occurredAt: "yesterday" }).ok).toBe(
      false
    );
  });

  it("rejects PHI-shaped extras", () => {
    expect(validateAgainst(OrderTypingStartedV1, { ...HAPPY, patientName: "Sample" }).ok).toBe(
      false
    );
  });
});
