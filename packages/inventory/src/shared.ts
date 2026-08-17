// Shared constants for the inventory domain (ADR-0035 slice 3).

// ---------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------

export const INVENTORY_SITE_NOT_FOUND = "INVENTORY_SITE_NOT_FOUND";
export const INVENTORY_PRODUCT_NOT_FOUND = "INVENTORY_PRODUCT_NOT_FOUND";
export const INVENTORY_LOT_EXPIRED_AT_RECEIPT = "INVENTORY_LOT_EXPIRED_AT_RECEIPT";
export const INVENTORY_EXPIRATION_MISMATCH = "INVENTORY_EXPIRATION_MISMATCH";
export const INVENTORY_TS_NOT_RECEIVED = "INVENTORY_TS_NOT_RECEIVED";
export const INVENTORY_RECEIPT_CONFLICT = "INVENTORY_RECEIPT_CONFLICT";
export const INVENTORY_LOT_NOT_FOUND = "INVENTORY_LOT_NOT_FOUND";
export const CATALOG_DUPLICATE_COMPOUND_PRODUCT = "CATALOG_DUPLICATE_COMPOUND_PRODUCT";
export const CATALOG_PRODUCT_CREATE_CONFLICT = "CATALOG_PRODUCT_CREATE_CONFLICT";

// Product catalog CRUD + AI guardrails (typing-assist phase 1).
export const INVENTORY_PRODUCT_NDC_CONFLICT = "INVENTORY_PRODUCT_NDC_CONFLICT";
export const INVENTORY_PRODUCT_NO_CHANGES = "INVENTORY_PRODUCT_NO_CHANGES";
export const INVENTORY_GUARDRAIL_CONFLICT = "INVENTORY_GUARDRAIL_CONFLICT";

// Compound batch lifecycle (PR 2).
export const BATCH_PRODUCT_NOT_COMPOUND = "BATCH_PRODUCT_NOT_COMPOUND";
export const BATCH_PRODUCT_SERIAL_IDENTITY_MISSING = "BATCH_PRODUCT_SERIAL_IDENTITY_MISSING";
export const BATCH_SITE_CODE_UNUSABLE = "BATCH_SITE_CODE_UNUSABLE";
export const BATCH_NUMBER_TOO_LONG_TO_PRINT = "BATCH_NUMBER_TOO_LONG_TO_PRINT";
export const BATCH_BUD_NOT_AFTER_COMPOUNDING = "BATCH_BUD_NOT_AFTER_COMPOUNDING";
export const BATCH_CREATE_CONFLICT = "BATCH_CREATE_CONFLICT";
export const BATCH_NOT_FOUND = "BATCH_NOT_FOUND";
export const BATCH_INVALID_TRANSITION = "BATCH_INVALID_TRANSITION";
export const BATCH_DISPENSING_CONFLICT = "BATCH_DISPENSING_CONFLICT";
export const BATCH_PAST_BUD = "BATCH_PAST_BUD";
export const BATCH_TEXT_REJECTED = "BATCH_TEXT_REJECTED";

// Compound stock label printing (PR 3).
export const BATCH_NOT_LABELABLE = "BATCH_NOT_LABELABLE";
export const BATCH_LABEL_PRINTER_NOT_FOUND = "BATCH_LABEL_PRINTER_NOT_FOUND";
export const BATCH_LABEL_PRINTER_INACTIVE = "BATCH_LABEL_PRINTER_INACTIVE";
export const BATCH_LABEL_PRINTER_WRONG_STOCK = "BATCH_LABEL_PRINTER_WRONG_STOCK";
export const BATCH_LABEL_TEMPLATE_NOT_FOUND = "BATCH_LABEL_TEMPLATE_NOT_FOUND";
export const BATCH_LABEL_REPRINT_REASON_REQUIRED = "BATCH_LABEL_REPRINT_REASON_REQUIRED";
export const BATCH_LABEL_UNIT_RANGE_INVALID = "BATCH_LABEL_UNIT_RANGE_INVALID";
export const BATCH_LABEL_UNIT_RANGE_TOO_LARGE = "BATCH_LABEL_UNIT_RANGE_TOO_LARGE";

// ---------------------------------------------------------------------
// Compound batch rejection reasons
// ---------------------------------------------------------------------

// Why a testing lab fails a batch. "Every rejection requires a reason
// code" — RejectCompoundBatch validates against this list, and the
// `compound_batch_rejection_reason_iff_rejected` CHECK backstops the
// column. OTHER exists because labs fail batches for reasons this
// list will never fully enumerate; the audit metadata carries the
// free-text detail.
export const COMPOUND_BATCH_REJECTION_REASONS = [
  "POTENCY_OUT_OF_SPEC",
  "STERILITY_FAILURE",
  "ENDOTOXIN_FAILURE",
  "PARTICULATE_MATTER",
  "CONTAMINATION",
  "PH_OUT_OF_RANGE",
  "LABELING_ERROR",
  "OTHER",
] as const;

export type CompoundBatchRejectionReason = (typeof COMPOUND_BATCH_REJECTION_REASONS)[number];
