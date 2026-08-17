// Compound stock label rendering — batch labels and unit labels.
//
// Shares all ZPL field safety with the patient vial label via
// `zpl-render.ts`; what differs is the placeholder set and the field
// maxima for each canvas.
//
// Both labels print an identifier that is ALSO the payload of a
// barcode on the same label:
//
//   batch label  `batchNumber` is printed as text and embedded in
//                `batchBarcodeValue` (`PXB:<productId>:<batchNumber>`).
//   unit label   `serialNumber` is printed as text and IS the payload
//                of `serialBarcodeValue` — the same string, passed
//                twice under distinct placeholder names to keep the
//                two paths explicit.
//
// Those go to `identityValues`, not `values`, so the renderer refuses
// to truncate them (see `zpl-render.ts`). Their maxima below are what
// physically fits the canvas; keeping an identity inside that budget
// is the MINTING side's job — see COMPOUND_BATCH_NUMBER_PRINT_MAX,
// which `CreateCompoundBatch` enforces when it builds a batch number.
// In practice both are `[A-Z0-9-]` only, so escaping is a no-op and
// printed and encoded copies are byte-identical.

import { renderZplTemplate } from "./zpl-render.js";
import type { CompoundBatchLabelRenderInput, CompoundUnitLabelRenderInput } from "./types.js";

export const COMPOUND_LABEL_BARCODE_INVALID = "COMPOUND_LABEL_BARCODE_INVALID";
export const COMPOUND_LABEL_IDENTITY_TOO_LONG = "COMPOUND_LABEL_IDENTITY_TOO_LONG";

/**
 * Longest batch number the batch label can print faithfully.
 *
 * Exported because it is a constraint on MINTING, not only on
 * rendering: a batch number that cannot be printed beside its own
 * barcode must never be assigned to physical stock in the first
 * place. `CreateCompoundBatch` checks against this same number so the
 * two cannot drift apart.
 *
 * A unit serial is `<batchNumber>-<unitNumber>` with unitCount capped
 * at 5000, so a batch number within this budget yields a serial of at
 * most 28 + 1 + 4 = 33 — comfortably inside the unit label's own
 * maximum below.
 */
export const COMPOUND_BATCH_NUMBER_PRINT_MAX = 28;

const BATCH_FIELD_MAX_LENGTH: Readonly<Record<string, number>> = Object.freeze({
  productName: 34,
  productStrength: 24,
  compoundedOn: 12,
  beyondUseDate: 12,
  unitCount: 6,
  pharmaxProductId: 20,
  batchNumber: COMPOUND_BATCH_NUMBER_PRINT_MAX,
});

const UNIT_FIELD_MAX_LENGTH: Readonly<Record<string, number>> = Object.freeze({
  productName: 32,
  productStrength: 24,
  beyondUseDate: 12,
  unitNumber: 6,
  unitCount: 6,
  // Above any serial a within-budget batch number can produce (33),
  // with room for the wider serials a redesigned template may carry.
  serialNumber: 48,
});

export function renderCompoundBatchLabelZpl(
  templateBody: string,
  input: CompoundBatchLabelRenderInput
): string {
  return renderZplTemplate({
    templateBody,
    labelKind: "compound batch label",
    barcodeErrorCode: COMPOUND_LABEL_BARCODE_INVALID,
    identityErrorCode: COMPOUND_LABEL_IDENTITY_TOO_LONG,
    fieldMaxLength: BATCH_FIELD_MAX_LENGTH,
    barcodeValues: { batchBarcodeValue: input.batchBarcodeValue },
    identityValues: { batchNumber: input.batchNumber },
    values: {
      productName: input.productName,
      productStrength: input.productStrength ?? "",
      compoundedOn: input.compoundedOn,
      beyondUseDate: input.beyondUseDate,
      unitCount: String(input.unitCount),
      pharmaxProductId: input.pharmaxProductId,
    },
  });
}

export function renderCompoundUnitLabelZpl(
  templateBody: string,
  input: CompoundUnitLabelRenderInput
): string {
  return renderZplTemplate({
    templateBody,
    labelKind: "compound unit label",
    barcodeErrorCode: COMPOUND_LABEL_BARCODE_INVALID,
    identityErrorCode: COMPOUND_LABEL_IDENTITY_TOO_LONG,
    fieldMaxLength: UNIT_FIELD_MAX_LENGTH,
    barcodeValues: { serialBarcodeValue: input.serialNumber },
    identityValues: { serialNumber: input.serialNumber },
    values: {
      productName: input.productName,
      productStrength: input.productStrength ?? "",
      beyondUseDate: input.beyondUseDate,
      unitNumber: String(input.unitNumber),
      unitCount: String(input.unitCount),
    },
  });
}
