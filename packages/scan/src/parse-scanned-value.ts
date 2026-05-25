import { normalizeNdc } from "./normalize-ndc.js";
import { parseGs1, type ParsedGs1 } from "./parse-gs1.js";

export type ScannedValueKind = "GS1" | "NDC" | "VIAL_LABEL" | "LOT" | "UNKNOWN";

export interface ParsedScannedValueBase {
  readonly raw: string;
  readonly kind: ScannedValueKind;
}

export interface ParsedGs1Scan extends ParsedScannedValueBase {
  readonly kind: "GS1";
  readonly gs1: ParsedGs1;
}

export interface ParsedNdcScan extends ParsedScannedValueBase {
  readonly kind: "NDC";
  readonly ndc11: string;
}

export interface ParsedVialLabelScan extends ParsedScannedValueBase {
  readonly kind: "VIAL_LABEL";
  readonly orderLineId: string;
}

export interface ParsedLotScan extends ParsedScannedValueBase {
  readonly kind: "LOT";
  readonly lotNumber: string;
}

export interface ParsedUnknownScan extends ParsedScannedValueBase {
  readonly kind: "UNKNOWN";
}

export type ParsedScannedValue =
  | ParsedGs1Scan
  | ParsedNdcScan
  | ParsedVialLabelScan
  | ParsedLotScan
  | ParsedUnknownScan;

const VIAL_LABEL_PATTERN = /^PX:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Classify and parse a raw scanner payload. */
export function parseScannedValue(raw: string): ParsedScannedValue {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { raw, kind: "UNKNOWN" };
  }

  const vialMatch = VIAL_LABEL_PATTERN.exec(trimmed);
  if (vialMatch !== null) {
    return {
      raw: trimmed,
      kind: "VIAL_LABEL",
      orderLineId: vialMatch[1]!.toLowerCase(),
    };
  }

  const gs1 = parseGs1(trimmed);
  if (gs1 !== null) {
    return { raw: trimmed, kind: "GS1", gs1 };
  }

  const ndc11 = normalizeNdc(trimmed);
  if (ndc11 !== null) {
    return { raw: trimmed, kind: "NDC", ndc11 };
  }

  if (/^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$/.test(trimmed)) {
    return { raw: trimmed, kind: "LOT", lotNumber: trimmed };
  }

  return { raw: trimmed, kind: "UNKNOWN" };
}
