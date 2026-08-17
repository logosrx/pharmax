// @pharmax/inventory — lot receiving + DSCSA chain of custody
// (ADR-0035 slice 3) and the compound product catalog. Fill owns
// consumption; compounding owns preparation; this package owns the
// inbound edge of the Lot/InventoryTransaction spine, the
// recall-response read, and catalog creation of in-house compounds
// (Pharmax Product ID minting).

export { ReceiveLot, type ReceiveLotInput, type ReceiveLotOutput } from "./commands/receive-lot.js";
export {
  CreateCompoundProduct,
  type CreateCompoundProductInput,
  type CreateCompoundProductOutput,
} from "./commands/create-compound-product.js";
export {
  CreateProduct,
  type CreateProductInput,
  type CreateProductOutput,
} from "./commands/create-product.js";
export {
  UpdateProduct,
  type UpdateProductInput,
  type UpdateProductOutput,
} from "./commands/update-product.js";
export {
  SetProductAiGuardrail,
  type SetProductAiGuardrailInput,
  type SetProductAiGuardrailOutput,
} from "./commands/set-product-ai-guardrail.js";
export {
  CreateCompoundBatch,
  type CreateCompoundBatchInput,
  type CreateCompoundBatchOutput,
} from "./commands/create-compound-batch.js";
export {
  SendCompoundBatchToTesting,
  type SendCompoundBatchToTestingInput,
  ReleaseCompoundBatch,
  type ReleaseCompoundBatchInput,
  RejectCompoundBatch,
  type RejectCompoundBatchInput,
  StartDispensingCompoundBatch,
  type StartDispensingCompoundBatchInput,
  type CompoundBatchTransitionOutput,
} from "./commands/compound-batch-transitions.js";
export {
  COMPOUND_UNIT_LABEL_MAX_PER_COMMAND,
  PrintCompoundBatchLabel,
  type PrintCompoundBatchLabelInput,
  type PrintCompoundBatchLabelOutput,
  PrintCompoundUnitLabels,
  type PrintCompoundUnitLabelsInput,
  type PrintCompoundUnitLabelsOutput,
} from "./commands/print-compound-labels.js";
export { getLotChainOfCustody, type LotChainOfCustody } from "./queries/lot-chain-of-custody.js";
export {
  COMPOUND_SCAN_BLOCKERS,
  type CompoundScanBlocker,
  resolveCompoundScan,
  type ResolveCompoundScanArgs,
  type ResolvedCompoundScan,
  SCAN_BLOCKER_BATCH_NOT_RELEASED,
  SCAN_BLOCKER_BATCH_REJECTED,
  SCAN_BLOCKER_PAST_BUD,
} from "./queries/resolve-compound-scan.js";

export {
  buildBatchBarcodeValue,
  buildBatchNumber,
  buildUnitSerial,
  COMPOUND_BATCH_BARCODE_PREFIX,
  formatCompoundedOnCode,
  normalizeSiteSerialCode,
} from "./compound-batch-serial.js";
export { isPastBeyondUseDate } from "./compound-batch-bud.js";

export {
  allocatePharmaxProductId,
  formatPharmaxProductId,
  PHARMAX_PRODUCT_ID_ALLOCATION_FAILED,
  PHARMAX_PRODUCT_ID_PAD_WIDTH,
  PHARMAX_PRODUCT_ID_PREFIX,
} from "./pharmax-product-id.js";

export {
  BATCH_BUD_NOT_AFTER_COMPOUNDING,
  BATCH_CREATE_CONFLICT,
  BATCH_DISPENSING_CONFLICT,
  BATCH_INVALID_TRANSITION,
  BATCH_LABEL_PRINTER_INACTIVE,
  BATCH_LABEL_PRINTER_NOT_FOUND,
  BATCH_LABEL_PRINTER_WRONG_STOCK,
  BATCH_LABEL_REPRINT_REASON_REQUIRED,
  BATCH_LABEL_TEMPLATE_NOT_FOUND,
  BATCH_LABEL_UNIT_RANGE_INVALID,
  BATCH_LABEL_UNIT_RANGE_TOO_LARGE,
  BATCH_NOT_FOUND,
  BATCH_NOT_LABELABLE,
  BATCH_PAST_BUD,
  BATCH_PRODUCT_NOT_COMPOUND,
  BATCH_PRODUCT_SERIAL_IDENTITY_MISSING,
  BATCH_SITE_CODE_UNUSABLE,
  BATCH_TEXT_REJECTED,
  CATALOG_DUPLICATE_COMPOUND_PRODUCT,
  CATALOG_PRODUCT_CREATE_CONFLICT,
  COMPOUND_BATCH_REJECTION_REASONS,
  type CompoundBatchRejectionReason,
  INVENTORY_EXPIRATION_MISMATCH,
  INVENTORY_GUARDRAIL_CONFLICT,
  INVENTORY_LOT_EXPIRED_AT_RECEIPT,
  INVENTORY_LOT_NOT_FOUND,
  INVENTORY_PRODUCT_NDC_CONFLICT,
  INVENTORY_PRODUCT_NO_CHANGES,
  INVENTORY_PRODUCT_NOT_FOUND,
  INVENTORY_RECEIPT_CONFLICT,
  INVENTORY_SITE_NOT_FOUND,
  INVENTORY_TS_NOT_RECEIVED,
} from "./shared.js";
