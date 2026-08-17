// Vial-label ZPL rendering.
//
// The escaping, bounding, and barcode-validation rules live in
// `zpl-render.ts` — they are properties of ZPL and are shared with the
// compound batch and unit labels. This module supplies only what is
// specific to the patient vial label: which placeholders exist, and
// how long each may be on the 2x1 canvas.
//
// Field bounding matters here beyond tidiness: a long compounded drug
// name or SIG that overflows the canvas prints over the lot line or
// the barcode, and an overflowed barcode fails the final-verification
// scan.

import { escapeZplFieldData, renderZplTemplate } from "./zpl-render.js";
import type { VialLabelRenderInput } from "./types.js";

export const VIAL_LABEL_BARCODE_INVALID = "VIAL_LABEL_BARCODE_INVALID";

/**
 * Per-field character maxima for the 2x1 default template. Values are
 * conservative for the template's font sizes; a redesigned template
 * ships with its own limits.
 */
const FIELD_MAX_LENGTH: Readonly<Record<string, number>> = Object.freeze({
  patientDisplayName: 32,
  drugName: 36,
  drugStrength: 16,
  drugNdc: 16,
  rxNumber: 24,
  quantity: 12,
  daysSupply: 8,
  sigText: 80,
  lotNumber: 24,
  lotExpiration: 12,
});

function normalizeStrength(strength: string | null): string {
  return strength?.trim() ?? "";
}

export function renderVialLabelZpl(templateBody: string, input: VialLabelRenderInput): string {
  return renderZplTemplate({
    templateBody,
    labelKind: "vial label",
    barcodeErrorCode: VIAL_LABEL_BARCODE_INVALID,
    fieldMaxLength: FIELD_MAX_LENGTH,
    barcodeValues: { barcodeValue: input.barcodeValue },
    values: {
      patientDisplayName: input.patientDisplayName,
      drugName: input.drugName,
      drugStrength: normalizeStrength(input.drugStrength),
      drugNdc: input.drugNdc,
      rxNumber: input.rxNumber,
      quantity: input.quantity,
      daysSupply: String(input.daysSupply),
      sigText: input.sigText,
      lotNumber: input.lotNumber,
      lotExpiration: input.lotExpiration,
    },
  });
}

// Re-exported for the existing tests and any consumer that escapes
// field data before handing it to a renderer.
export { escapeZplFieldData };
