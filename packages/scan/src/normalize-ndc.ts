const NDC_11_DIGIT_LENGTH = 11;
const NDC_10_DIGIT_LENGTH = 10;

export const NDC_INVALID = "NDC_INVALID";

/** Strip separators and normalize to an 11-digit NDC string. */
export function normalizeNdc(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === NDC_11_DIGIT_LENGTH) {
    return digits;
  }
  if (digits.length === NDC_10_DIGIT_LENGTH) {
    return `0${digits}`;
  }
  return null;
}
