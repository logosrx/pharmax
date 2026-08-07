const NDC_11_DIGIT_LENGTH = 11;
const NDC_10_DIGIT_LENGTH = 10;

export const NDC_INVALID = "NDC_INVALID";

/**
 * Strip separators and normalize to an 11-digit (5-4-2) NDC string.
 *
 * 10-digit NDCs exist in THREE hyphenated formats, and the padding
 * zero goes in a DIFFERENT segment per format:
 *
 *   4-4-2  → pad the LABELER:  4-4-2  → 04-4-2   (prepend)
 *   5-3-2  → pad the PRODUCT:  5-3-2  → 5-04-2   (position 5)
 *   5-4-1  → pad the PACKAGE:  5-4-1  → 5-4-01   (position 9)
 *
 * When the raw value carries separators, the segment lengths tell
 * us exactly where the zero belongs. Blindly prepending — the old
 * behavior — mis-normalized every 5-3-2 and 5-4-1 NDC, so a
 * perfectly valid product scan hard-stopped fill completion with an
 * NDC mismatch.
 *
 * A BARE 10-digit value (no separators) is genuinely ambiguous; we
 * keep the historical 4-4-2 assumption (prepend) for that case —
 * matching how UPC-derived product barcodes most commonly encode.
 */
export function normalizeNdc(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === NDC_11_DIGIT_LENGTH) {
    return digits;
  }
  if (digits.length !== NDC_10_DIGIT_LENGTH) {
    return null;
  }

  // Hyphenated (or otherwise separated) 10-digit NDC: use the
  // segment shape to place the padding zero.
  const segments = trimmed.split(/[^0-9]+/).filter((s) => s.length > 0);
  if (segments.length === 3) {
    const [labeler, product, pkg] = [segments[0]!, segments[1]!, segments[2]!];
    const shape = `${labeler.length}-${product.length}-${pkg.length}`;
    switch (shape) {
      case "4-4-2":
        return `0${labeler}${product}${pkg}`;
      case "5-3-2":
        return `${labeler}0${product}${pkg}`;
      case "5-4-1":
        return `${labeler}${product}0${pkg}`;
      default:
        return null;
    }
  }

  // Bare 10 digits — ambiguous; assume 4-4-2 (prepend).
  return `0${digits}`;
}
