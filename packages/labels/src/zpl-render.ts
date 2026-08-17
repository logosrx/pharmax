// Shared ZPL field-safety and template substitution.
//
// Extracted from `render-vial-label-zpl.ts` when compound batch and
// unit labels arrived. The escaping rules below are properties of ZPL
// itself, not of any one label, so every label kind must get them —
// and a second copy would be a second thing to forget to fix.
//
// Why escaping is load-bearing: ZPL treats `^` and `~` as command
// prefixes ANYWHERE in the byte stream, including inside `^FD...^FS`
// field data. Substituting operator-entered text raw therefore lets a
// stray caret — or a literal "^FS" pasted from another system —
// terminate the field early and reinterpret the remainder as
// commands. The result is a garbled label, a missing field, or a label
// that silently does not print. On a pharmacy label that is a
// patient-safety problem as much as an injection problem.
//
// The strategy is substitution rather than ZPL's `^FH` hex mode: a
// caret or tilde has no typographic meaning on a small thermal label,
// and swapping it for a visually equivalent codepoint cannot change
// the label's SEMANTIC content (drug, dose, lot, serial). Newlines
// collapse to spaces because a raw newline inside `^FD` is
// printer-model-dependent.
//
// Barcodes are exempt from both escaping and truncation and are
// VALIDATED instead. A scanner re-reads that value and the system
// resolves it back to a row, so altering even one character breaks
// traceability. All barcode payloads here are machine-generated, so a
// ZPL-active character in one means an upstream bug, not bad operator
// input — it should be loud.

import { errors } from "@pharmax/platform-core";

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

const TRUNCATION_MARKER = "…";

/**
 * Replace ZPL-active characters with visually-equivalent safe ones and
 * collapse newlines.
 */
export function escapeZplFieldData(value: string): string {
  return value
    .replace(/\^/g, "ˆ") // U+02C6 modifier circumflex — prints, never commands
    .replace(/~/g, "˜") // U+02DC small tilde
    .replace(/[\r\n]+/g, " ");
}

function containsZplUnsafeCharacters(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "^" || ch === "~" || code < 0x20) return true;
  }
  return false;
}

/**
 * Reject a barcode payload carrying ZPL-active or non-printable
 * characters. Callers pass their own error code so the failure names
 * the label kind that produced it.
 */
export function assertBarcodeSafe(value: string, errorCode: string): string {
  if (containsZplUnsafeCharacters(value)) {
    throw new errors.ValidationError({
      code: errorCode,
      message: "Barcode value contains ZPL control characters and cannot be rendered.",
      issues: [{ path: ["barcodeValue"], message: "contains ZPL-active characters" }],
      metadata: { length: value.length },
    });
  }
  return value;
}

export interface RenderZplTemplateArgs {
  readonly templateBody: string;
  /** Placeholder name → text value. Escaped and length-bounded. */
  readonly values: Readonly<Record<string, string>>;
  /**
   * Placeholder names whose values are barcode payloads: validated
   * verbatim rather than escaped or truncated.
   */
  readonly barcodeValues: Readonly<Record<string, string>>;
  /** Per-field character maxima, sized for the template's fonts. */
  readonly fieldMaxLength: Readonly<Record<string, number>>;
  /** Error code raised when a barcode payload is unsafe. */
  readonly barcodeErrorCode: string;
  /** Label kind, used only in the missing-placeholder message. */
  readonly labelKind: string;
}

/**
 * Substitute `{{placeholder}}` tokens in a ZPL template body.
 *
 * An unknown placeholder is a hard error rather than an empty string:
 * a template referencing a field the renderer does not supply would
 * otherwise print a label with a silently blank drug name or serial.
 */
export function renderZplTemplate(args: RenderZplTemplateArgs): string {
  const safeBarcodes = new Map<string, string>();
  for (const [key, raw] of Object.entries(args.barcodeValues)) {
    safeBarcodes.set(key, assertBarcodeSafe(raw, args.barcodeErrorCode));
  }

  return args.templateBody.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const barcode = safeBarcodes.get(key);
    if (barcode !== undefined) return barcode;

    const value = args.values[key];
    if (value === undefined) {
      throw new Error(`Missing ${args.labelKind} template placeholder: ${key}`);
    }

    const escaped = escapeZplFieldData(value);
    const max = args.fieldMaxLength[key];
    if (max === undefined || escaped.length <= max) return escaped;
    return `${escaped.slice(0, max - 1)}${TRUNCATION_MARKER}`;
  });
}
