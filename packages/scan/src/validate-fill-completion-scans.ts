import { buildVialBarcodeValue } from "@pharmax/labels";

import { normalizeNdc } from "./normalize-ndc.js";
import { parseScannedValue } from "./parse-scanned-value.js";

export type ScanValidationResult = "SUCCESS" | "HARD_STOP" | "FAILED";

export const FILL_SCAN_LINE_COUNT_MISMATCH = "FILL_SCAN_LINE_COUNT_MISMATCH";
export const FILL_SCAN_UNKNOWN_LINE = "FILL_SCAN_UNKNOWN_LINE";
export const FILL_SCAN_DUPLICATE_LINE = "FILL_SCAN_DUPLICATE_LINE";
export const FILL_SCAN_PARSE_FAILED = "FILL_SCAN_PARSE_FAILED";
export const FILL_SCAN_LOT_MISMATCH = "FILL_SCAN_LOT_MISMATCH";
export const FILL_SCAN_NDC_MISMATCH = "FILL_SCAN_NDC_MISMATCH";
export const FILL_SCAN_VIAL_LABEL_MISMATCH = "FILL_SCAN_VIAL_LABEL_MISMATCH";

export interface FillLineScanExpectation {
  readonly orderLineId: string;
  readonly expectedLotNumber: string;
  readonly expectedNdc: string;
}

export interface FillLineScanInput {
  readonly orderLineId: string;
  readonly lotScan: string;
  readonly vialLabelScan: string;
}

export interface ScanValidationFailure {
  readonly result: "HARD_STOP" | "FAILED";
  readonly code: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

export interface ScanValidationSuccess {
  readonly result: "SUCCESS";
}

export type FillScanValidationOutcome = ScanValidationSuccess | ScanValidationFailure;

function normalizeLotNumber(value: string): string {
  return value.trim().toUpperCase();
}

function extractLotAndNdcFromScan(raw: string): {
  lotNumber: string | null;
  ndc11: string | null;
} {
  const parsed = parseScannedValue(raw);
  switch (parsed.kind) {
    case "GS1": {
      return {
        lotNumber: parsed.gs1.fields.lotNumber,
        ndc11: parsed.gs1.fields.ndc11,
      };
    }
    case "NDC":
      return { lotNumber: null, ndc11: parsed.ndc11 };
    case "LOT":
      return { lotNumber: parsed.lotNumber, ndc11: null };
    default:
      return { lotNumber: null, ndc11: null };
  }
}

function validateVialLabelScan(orderLineId: string, raw: string): ScanValidationFailure | null {
  const parsed = parseScannedValue(raw);
  if (parsed.kind === "VIAL_LABEL") {
    if (parsed.orderLineId !== orderLineId.toLowerCase()) {
      return {
        result: "HARD_STOP",
        code: FILL_SCAN_VIAL_LABEL_MISMATCH,
        message: "Scanned vial label does not match the order line.",
        metadata: {
          orderLineId,
          scannedOrderLineId: parsed.orderLineId,
          scannedValue: raw,
        },
      };
    }
    return null;
  }

  const expected = buildVialBarcodeValue(orderLineId);
  if (raw.trim() !== expected) {
    return {
      result: "HARD_STOP",
      code: FILL_SCAN_VIAL_LABEL_MISMATCH,
      message: "Scanned vial label does not match the order line.",
      metadata: {
        orderLineId,
        expected,
        scannedValue: raw,
      },
    };
  }
  return null;
}

/** Validate fill-completion lot + vial label scans for every order line. */
export function validateFillCompletionScans(input: {
  readonly expectations: ReadonlyArray<FillLineScanExpectation>;
  readonly lineScans: ReadonlyArray<FillLineScanInput>;
}): FillScanValidationOutcome {
  const { expectations, lineScans } = input;

  if (lineScans.length !== expectations.length) {
    return {
      result: "HARD_STOP",
      code: FILL_SCAN_LINE_COUNT_MISMATCH,
      message: "Fill completion requires one scan set per order line.",
      metadata: {
        expectedLineCount: expectations.length,
        providedLineCount: lineScans.length,
      },
    };
  }

  const seenLineIds = new Set<string>();
  for (const scan of lineScans) {
    if (seenLineIds.has(scan.orderLineId)) {
      return {
        result: "HARD_STOP",
        code: FILL_SCAN_DUPLICATE_LINE,
        message: "Duplicate scan payload for the same order line.",
        metadata: { orderLineId: scan.orderLineId },
      };
    }
    seenLineIds.add(scan.orderLineId);
  }

  const expectationByLineId = new Map(
    expectations.map((expectation) => [expectation.orderLineId, expectation])
  );

  for (const scan of lineScans) {
    const expectation = expectationByLineId.get(scan.orderLineId);
    if (expectation === undefined) {
      return {
        result: "HARD_STOP",
        code: FILL_SCAN_UNKNOWN_LINE,
        message: "Scan payload references an order line that is not on this order.",
        metadata: { orderLineId: scan.orderLineId },
      };
    }

    const lotExtract = extractLotAndNdcFromScan(scan.lotScan);
    if (lotExtract.lotNumber === null && lotExtract.ndc11 === null) {
      return {
        result: "HARD_STOP",
        code: FILL_SCAN_PARSE_FAILED,
        message: "Lot scan could not be parsed as GS1, NDC, or lot barcode.",
        metadata: {
          orderLineId: scan.orderLineId,
          lotScan: scan.lotScan,
        },
      };
    }

    if (lotExtract.lotNumber !== null) {
      const scannedLot = normalizeLotNumber(lotExtract.lotNumber);
      const expectedLot = normalizeLotNumber(expectation.expectedLotNumber);
      if (scannedLot !== expectedLot) {
        return {
          result: "HARD_STOP",
          code: FILL_SCAN_LOT_MISMATCH,
          message: "Scanned lot number does not match the assigned lot.",
          metadata: {
            orderLineId: scan.orderLineId,
            expectedLotNumber: expectation.expectedLotNumber,
            scannedLotNumber: lotExtract.lotNumber,
          },
        };
      }
    }

    const expectedNdc = normalizeNdc(expectation.expectedNdc);
    if (expectedNdc === null) {
      return {
        result: "FAILED",
        code: FILL_SCAN_PARSE_FAILED,
        message: "Expected NDC on the order line is invalid.",
        metadata: {
          orderLineId: scan.orderLineId,
          expectedNdc: expectation.expectedNdc,
        },
      };
    }

    if (lotExtract.ndc11 !== null) {
      if (lotExtract.ndc11 !== expectedNdc) {
        return {
          result: "HARD_STOP",
          code: FILL_SCAN_NDC_MISMATCH,
          message: "Scanned product NDC does not match the assigned lot product.",
          metadata: {
            orderLineId: scan.orderLineId,
            expectedNdc,
            scannedNdc: lotExtract.ndc11,
          },
        };
      }
    } else if (lotExtract.lotNumber === null) {
      return {
        result: "HARD_STOP",
        code: FILL_SCAN_PARSE_FAILED,
        message: "Lot scan must include a lot number or product NDC.",
        metadata: {
          orderLineId: scan.orderLineId,
          lotScan: scan.lotScan,
        },
      };
    }

    const vialFailure = validateVialLabelScan(scan.orderLineId, scan.vialLabelScan);
    if (vialFailure !== null) {
      return vialFailure;
    }
  }

  for (const expectation of expectations) {
    if (!seenLineIds.has(expectation.orderLineId)) {
      return {
        result: "HARD_STOP",
        code: FILL_SCAN_LINE_COUNT_MISMATCH,
        message: "Fill completion requires scans for every order line.",
        metadata: {
          missingOrderLineId: expectation.orderLineId,
        },
      };
    }
  }

  return { result: "SUCCESS" };
}
