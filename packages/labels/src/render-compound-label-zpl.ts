// Compound stock label rendering — batch labels and unit labels.
//
// Shares all ZPL field safety with the patient vial label via
// `zpl-render.ts`; what differs is the placeholder set and the field
// maxima for each canvas.
//
// Note the deliberate pairing on the unit label: `serialBarcodeValue`
// and `serialNumber` receive the SAME string, but travel different
// paths — the former is validated verbatim as a barcode payload, the
// latter is escaped and bounded as printed text. Distinct placeholder
// names keep that explicit. In practice serials are `[A-Z0-9-]` only,
// so escaping is a no-op and the two always agree; the field maximum
// is set well above the real length so a serial can never be
// truncated into disagreeing with its own barcode.

import { renderZplTemplate } from "./zpl-render.js";
import type { CompoundBatchLabelRenderInput, CompoundUnitLabelRenderInput } from "./types.js";

export const COMPOUND_LABEL_BARCODE_INVALID = "COMPOUND_LABEL_BARCODE_INVALID";

const BATCH_FIELD_MAX_LENGTH: Readonly<Record<string, number>> = Object.freeze({
  productName: 34,
  productStrength: 24,
  compoundedOn: 12,
  beyondUseDate: 12,
  unitCount: 6,
  pharmaxProductId: 20,
  batchNumber: 28,
});

const UNIT_FIELD_MAX_LENGTH: Readonly<Record<string, number>> = Object.freeze({
  productName: 32,
  productStrength: 24,
  beyondUseDate: 12,
  unitNumber: 6,
  unitCount: 6,
  // Above any real serial (site code + drug code + day seq + date +
  // unit number). Truncating a serial would make the printed identity
  // disagree with its own barcode.
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
    fieldMaxLength: BATCH_FIELD_MAX_LENGTH,
    barcodeValues: { batchBarcodeValue: input.batchBarcodeValue },
    values: {
      productName: input.productName,
      productStrength: input.productStrength ?? "",
      compoundedOn: input.compoundedOn,
      beyondUseDate: input.beyondUseDate,
      unitCount: String(input.unitCount),
      pharmaxProductId: input.pharmaxProductId,
      batchNumber: input.batchNumber,
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
    fieldMaxLength: UNIT_FIELD_MAX_LENGTH,
    barcodeValues: { serialBarcodeValue: input.serialNumber },
    values: {
      productName: input.productName,
      productStrength: input.productStrength ?? "",
      beyondUseDate: input.beyondUseDate,
      unitNumber: String(input.unitNumber),
      unitCount: String(input.unitCount),
      serialNumber: input.serialNumber,
    },
  });
}
