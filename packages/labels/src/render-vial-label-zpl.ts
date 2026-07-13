// Vial-label ZPL rendering with control-character escaping and
// field bounding.
//
// ZPL treats `^` (caret) and `~` (tilde) as command prefixes
// ANYWHERE in the data stream, including inside `^FD...^FS` field
// data. Raw substitution of operator-entered text (drug names,
// SIGs, patient display names) therefore let a stray `^` or `~` —
// or a literal "^FS" pasted from another system — terminate the
// field early and reinterpret the rest of the value as ZPL
// commands: garbled labels, missing fields, or an entire label
// silently not printing. That is both a patient-safety and an
// injection problem.
//
// Escaping strategy: ZPL's `^FH` (field hexadecimal) mode escapes
// arbitrary bytes as `_hh`. Rather than rewrite every template to
// carry `^FH`, we substitute the ZPL-active characters with safe
// visual equivalents — a caret/tilde in a drug name has no
// typographic meaning on a 2x1 vial label, and the swap cannot
// change the label's SEMANTIC content (dose, drug, lot, patient).
// Newlines collapse to spaces (a raw newline inside ^FD is
// printer-model-dependent).
//
// Length bounding: text fields are truncated (with an ellipsis
// marker) at conservative per-field maxima so a long compounded
// drug name or SIG cannot overflow the 2x1 canvas and print over
// the lot line or the barcode — an overflowed barcode fails the
// final-verification scan. The BARCODE value is exempt from both
// escaping and truncation: it is machine-generated (`PX:<uuid>`),
// and any alteration would break scan validation — it is instead
// VALIDATED and rejected if it carries ZPL-active characters.

import { errors } from "@pharmax/platform-core";

import type { VialLabelRenderInput } from "./types.js";

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

export const VIAL_LABEL_BARCODE_INVALID = "VIAL_LABEL_BARCODE_INVALID";

/**
 * Per-field character maxima for the 2x1 default template. Values
 * are conservative for the template's font sizes; a redesigned
 * template ships with its own limits.
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

const TRUNCATION_MARKER = "…";

/**
 * Replace ZPL-active characters with visually-equivalent safe ones
 * and collapse newlines. Exported for tests.
 */
export function escapeZplFieldData(value: string): string {
  return value
    .replace(/\^/g, "ˆ") // U+02C6 modifier circumflex — prints, never commands
    .replace(/~/g, "˜") // U+02DC small tilde
    .replace(/[\r\n]+/g, " ");
}

function boundField(key: string, value: string): string {
  const max = FIELD_MAX_LENGTH[key];
  if (max === undefined || value.length <= max) return value;
  return `${value.slice(0, max - 1)}${TRUNCATION_MARKER}`;
}

/**
 * Barcode content must survive verbatim (scanners re-read it), so
 * it is validated rather than escaped: ZPL-active or non-printable
 * characters are a hard error — the upstream generator only emits
 * `PX:<uuid>` shapes, so hitting this means a bug, not bad user
 * input.
 */
function containsZplUnsafeCharacters(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "^" || ch === "~" || code < 0x20) return true;
  }
  return false;
}

function assertBarcodeSafe(value: string): string {
  if (containsZplUnsafeCharacters(value)) {
    throw new errors.ValidationError({
      code: VIAL_LABEL_BARCODE_INVALID,
      message: "Barcode value contains ZPL control characters and cannot be rendered.",
      issues: [{ path: ["barcodeValue"], message: "contains ZPL-active characters" }],
      metadata: { length: value.length },
    });
  }
  return value;
}

function normalizeStrength(strength: string | null): string {
  return strength?.trim() ?? "";
}

export function renderVialLabelZpl(templateBody: string, input: VialLabelRenderInput): string {
  const values: Record<string, string> = {
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
  };

  const barcodeValue = assertBarcodeSafe(input.barcodeValue);

  return templateBody.replace(PLACEHOLDER_RE, (_match, key: string) => {
    if (key === "barcodeValue") {
      return barcodeValue;
    }
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Missing vial label template placeholder: ${key}`);
    }
    return boundField(key, escapeZplFieldData(value));
  });
}
