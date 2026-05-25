export const VIAL_LABEL_REPRINT_REASONS = [
  "LABEL_DAMAGED",
  "PRINTER_JAM",
  "WRONG_LABEL_APPLIED",
  "BARCODE_UNREADABLE",
  "TEMPLATE_MISALIGNMENT",
  "OTHER",
] as const;

export type VialLabelReprintReason = (typeof VIAL_LABEL_REPRINT_REASONS)[number];

export const VIAL_LABEL_REPRINT_REASONS_SET: ReadonlySet<string> = new Set(
  VIAL_LABEL_REPRINT_REASONS
);

export function isVialLabelReprintReason(value: string): value is VialLabelReprintReason {
  return VIAL_LABEL_REPRINT_REASONS_SET.has(value);
}
