import { describe, expect, it } from "vitest";

import { buildVialBarcodeValue } from "@pharmax/labels";

import {
  FILL_SCAN_LINE_COUNT_MISMATCH,
  FILL_SCAN_LOT_MISMATCH,
  FILL_SCAN_NDC_MISMATCH,
  FILL_SCAN_VIAL_LABEL_MISMATCH,
  validateFillCompletionScans,
} from "./validate-fill-completion-scans.js";

const ORDER_LINE_ID = "00000000-0000-4000-8000-0000000000bb";
const EXPECTED_NDC = "12345678901";
const EXPECTED_LOT = "LOT-A1";

const expectations = [
  {
    orderLineId: ORDER_LINE_ID,
    expectedLotNumber: EXPECTED_LOT,
    expectedNdc: EXPECTED_NDC,
  },
];

describe("validateFillCompletionScans", () => {
  it("accepts lot-only GS1 scan + vial label scan", () => {
    const outcome = validateFillCompletionScans({
      expectations,
      lineScans: [
        {
          orderLineId: ORDER_LINE_ID,
          lotScan: `(10)${EXPECTED_LOT}`,
          vialLabelScan: buildVialBarcodeValue(ORDER_LINE_ID),
        },
      ],
    });
    expect(outcome.result).toBe("SUCCESS");
  });

  it("accepts GS1 GTIN + lot when NDC matches assigned lot product", () => {
    const outcome = validateFillCompletionScans({
      expectations: [
        {
          orderLineId: ORDER_LINE_ID,
          expectedLotNumber: EXPECTED_LOT,
          expectedNdc: "03681409867",
        },
      ],
      lineScans: [
        {
          orderLineId: ORDER_LINE_ID,
          lotScan: `(01)00368140986755(10)${EXPECTED_LOT}`,
          vialLabelScan: buildVialBarcodeValue(ORDER_LINE_ID),
        },
      ],
    });
    expect(outcome.result).toBe("SUCCESS");
  });

  it("rejects lot mismatch as HARD_STOP", () => {
    const outcome = validateFillCompletionScans({
      expectations,
      lineScans: [
        {
          orderLineId: ORDER_LINE_ID,
          lotScan: `(10)WRONG-LOT`,
          vialLabelScan: buildVialBarcodeValue(ORDER_LINE_ID),
        },
      ],
    });
    expect(outcome).toMatchObject({
      result: "HARD_STOP",
      code: FILL_SCAN_LOT_MISMATCH,
    });
  });

  it("rejects NDC mismatch as HARD_STOP", () => {
    const outcome = validateFillCompletionScans({
      expectations,
      lineScans: [
        {
          orderLineId: ORDER_LINE_ID,
          lotScan: `(01)00368140986755(10)${EXPECTED_LOT}`,
          vialLabelScan: buildVialBarcodeValue(ORDER_LINE_ID),
        },
      ],
    });
    expect(outcome).toMatchObject({
      result: "HARD_STOP",
      code: FILL_SCAN_NDC_MISMATCH,
    });
  });

  it("rejects vial label mismatch as HARD_STOP", () => {
    const outcome = validateFillCompletionScans({
      expectations,
      lineScans: [
        {
          orderLineId: ORDER_LINE_ID,
          lotScan: `(10)${EXPECTED_LOT}`,
          vialLabelScan: "PX:00000000-0000-4000-8000-000000000099",
        },
      ],
    });
    expect(outcome).toMatchObject({
      result: "HARD_STOP",
      code: FILL_SCAN_VIAL_LABEL_MISMATCH,
    });
  });

  it("rejects missing line scans", () => {
    const outcome = validateFillCompletionScans({
      expectations,
      lineScans: [],
    });
    expect(outcome).toMatchObject({
      result: "HARD_STOP",
      code: FILL_SCAN_LINE_COUNT_MISMATCH,
    });
  });
});
