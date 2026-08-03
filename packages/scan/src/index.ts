// Re-exported from `@pharmax/drug-identity`, where the normalizer now
// lives so `@pharmax/orders` can share it without a domain -> domain
// edge. Kept on this barrel because scan's existing consumers import
// it from here.
export { normalizeNdc, NDC_INVALID } from "@pharmax/drug-identity";
export { parseGs1, GS1_PARSE_FAILED, type ParsedGs1, type ParsedGs1Fields } from "./parse-gs1.js";
export {
  parseScannedValue,
  type ParsedScannedValue,
  type ScannedValueKind,
} from "./parse-scanned-value.js";
export {
  validateFillCompletionScans,
  FILL_SCAN_LINE_COUNT_MISMATCH,
  FILL_SCAN_UNKNOWN_LINE,
  FILL_SCAN_DUPLICATE_LINE,
  FILL_SCAN_PARSE_FAILED,
  FILL_SCAN_LOT_MISMATCH,
  FILL_SCAN_LOT_NUMBER_REQUIRED,
  FILL_SCAN_LOT_SCAN_REQUIRED,
  FILL_SCAN_COMPOUND_LOT_UNEXPECTED,
  FILL_SCAN_NDC_MISMATCH,
  FILL_SCAN_VIAL_LABEL_MISMATCH,
  type FillLineScanExpectation,
  type FillLineScanInput,
  type FillScanValidationOutcome,
  type ScanValidationFailure,
  type ScanValidationResult,
  type ScanValidationSuccess,
} from "./validate-fill-completion-scans.js";
