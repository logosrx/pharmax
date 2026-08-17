import { normalizeNdc } from "@pharmax/drug-identity";
import { parseGs1, type ParsedGs1 } from "./parse-gs1.js";

export type ScannedValueKind =
  "GS1" | "NDC" | "VIAL_LABEL" | "COMPOUND_BATCH" | "COMPOUND_UNIT" | "LOT" | "UNKNOWN";

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

/** Batch record label: `PXB:<pharmaxProductId>:<batchNumber>`. */
export interface ParsedCompoundBatchScan extends ParsedScannedValueBase {
  readonly kind: "COMPOUND_BATCH";
  readonly pharmaxProductId: string;
  readonly batchNumber: string;
}

/**
 * Per-unit vial label: the bare unit serial
 * `<batchNumber>-<unitNumber>`, e.g. `PHX-T30-1-040327-11`.
 */
export interface ParsedCompoundUnitScan extends ParsedScannedValueBase {
  readonly kind: "COMPOUND_UNIT";
  readonly serialNumber: string;
  readonly batchNumber: string;
  readonly unitNumber: number;
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
  | ParsedCompoundBatchScan
  | ParsedCompoundUnitScan
  | ParsedLotScan
  | ParsedUnknownScan;

const VIAL_LABEL_PATTERN = /^PX:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Compound stock label shapes.
//
// These mirror `buildBatchNumber` / `buildUnitSerial` /
// `buildBatchBarcodeValue` in `@pharmax/inventory`. They are restated
// here rather than imported, following the same convention as
// VIAL_LABEL_PATTERN above (which mirrors `buildVialBarcodeValue`
// without importing it): a parser recognizes shapes arriving from the
// physical world, and staying dependency-free keeps this package pure.
// A format change therefore has to be made in both places — there are
// pointer comments on the generators saying so.
//
//   batch number  <SITE>-<INITIAL><MG>-<DAYSEQ>-<MMDDYY>   PHX-T30-1-040327
//   unit serial   <batchNumber>-<unitNumber>                PHX-T30-1-040327-11
//   batch barcode PXB:<pharmaxProductId>:<batchNumber>
const BATCH_NUMBER_SOURCE = "[A-Z0-9]+-[A-Z]\\d+-\\d+-\\d{6}";

const COMPOUND_BATCH_PATTERN = new RegExp(`^PXB:(PXP-\\d+):(${BATCH_NUMBER_SOURCE})$`, "i");

const COMPOUND_UNIT_PATTERN = new RegExp(`^(${BATCH_NUMBER_SOURCE})-(\\d+)$`, "i");

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

  // Compound shapes are tested BEFORE the lot fallback below, which
  // accepts any dash-and-alphanumeric token and would otherwise
  // swallow every unit serial as a lot number. That misclassification
  // fails closed at fill (the serial does not match the assigned lot,
  // so the fill stops) but tells the operator "lot mismatch" for a
  // scan that was never a lot, and misroutes a scan-to-open.
  const batchMatch = COMPOUND_BATCH_PATTERN.exec(trimmed);
  if (batchMatch !== null) {
    return {
      raw: trimmed,
      kind: "COMPOUND_BATCH",
      pharmaxProductId: batchMatch[1]!.toUpperCase(),
      batchNumber: batchMatch[2]!.toUpperCase(),
    };
  }

  const unitMatch = COMPOUND_UNIT_PATTERN.exec(trimmed);
  if (unitMatch !== null) {
    return {
      raw: trimmed,
      kind: "COMPOUND_UNIT",
      // Serials are printed uppercase; normalize so a scanner
      // configured to lowercase still resolves against the stored row.
      serialNumber: trimmed.toUpperCase(),
      batchNumber: unitMatch[1]!.toUpperCase(),
      unitNumber: Number(unitMatch[2]),
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
