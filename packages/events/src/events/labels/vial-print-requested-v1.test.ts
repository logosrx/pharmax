// Schema tests for labels.vial_print.requested.v1.

import { describe, expect, it } from "vitest";

import { validateAgainst } from "../../define-event.js";
import { LabelsVialPrintRequestedV1 } from "./vial-print-requested-v1.js";

const HAPPY: Record<string, unknown> = Object.freeze({
  organizationId: "00000000-0000-4000-8000-000000000001",
  orderId: "00000000-0000-4000-8000-000000000002",
  orderLineId: "00000000-0000-4000-8000-000000000003",
  printJobId: "00000000-0000-4000-8000-000000000004",
  vialLabelId: "00000000-0000-4000-8000-000000000005",
  printerId: "00000000-0000-4000-8000-000000000006",
  workstationId: "00000000-0000-4000-8000-000000000007",
  templateCode: "default.zebra-zd420",
  templateVersion: 1,
  contentHashHex: "a".repeat(64),
  occurredAt: "2026-05-25T10:00:00.000Z",
});

describe("LabelsVialPrintRequestedV1 schema", () => {
  it("accepts a well-formed payload", () => {
    expect(validateAgainst(LabelsVialPrintRequestedV1, HAPPY).ok).toBe(true);
  });

  it("accepts null workstationId (non-workstation source)", () => {
    expect(validateAgainst(LabelsVialPrintRequestedV1, { ...HAPPY, workstationId: null }).ok).toBe(
      true
    );
  });

  it("rejects a non-hex contentHashHex", () => {
    expect(
      validateAgainst(LabelsVialPrintRequestedV1, { ...HAPPY, contentHashHex: "not-hex" }).ok
    ).toBe(false);
  });

  it("rejects a non-positive templateVersion", () => {
    expect(validateAgainst(LabelsVialPrintRequestedV1, { ...HAPPY, templateVersion: 0 }).ok).toBe(
      false
    );
  });

  it("aggregateIdFrom selects printJobId", () => {
    expect(LabelsVialPrintRequestedV1.aggregateIdFrom(HAPPY as never)).toBe(HAPPY.printJobId);
  });
});
