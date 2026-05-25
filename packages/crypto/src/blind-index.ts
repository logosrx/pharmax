// Blind index — searchable hash of an encrypted field.
//
// Problem this solves: AES-256-GCM ciphertext is non-deterministic
// (random IV per encrypt) so two encrypts of the same plaintext look
// completely different. `WHERE first_name_ct = $1` is impossible.
// The classic answer is a column adjacent to the ciphertext that
// stores `HMAC-SHA256(per-tenant-search-key, normalized-plaintext)`.
// That column IS searchable, IS deterministic, and reveals nothing
// useful without the per-tenant key.
//
// Threat model considerations:
//
//   - Per-tenant key separation means a blind-index hash from tenant
//     A is meaningless for queries against tenant B's rows. Even if
//     two tenants store the same plaintext, their blind indexes are
//     different.
//
//   - **Frequency analysis remains possible** inside one tenant: if
//     "John Smith" appears 100 times, all 100 rows share the same
//     blind index hash. We accept this; the alternative is a slower
//     primitive (e.g. searchable symmetric encryption) that's not
//     justified for our query patterns. Document this limitation
//     loudly in the patient-search code that USES blind indexes.
//
//   - Normalization is critical for matching. We lowercase, trim,
//     and NFD-normalize-then-strip-combining-marks so "Café" and
//     "Cafe" produce the same blind index. Phone numbers are
//     digit-stripped. DOB normalization is left to the caller to
//     avoid timezone surprises.
//
// Output format: base64url with no padding. 32 bytes of HMAC-SHA256
// produces a 43-character string. We store it in a TEXT column with
// a B-tree index.

import { createHmac } from "node:crypto";

import { getCryptoConfiguration } from "./configure.js";
import { cryptoValidationError } from "./errors.js";

/**
 * Lowercase, trim, NFD-normalize-and-strip-combining-marks, collapse
 * inner whitespace. Returns "" if the result is empty (caller's
 * decision whether to skip blind-indexing).
 */
export function normalizeForBlindIndex(value: string): string {
  if (typeof value !== "string") {
    throw cryptoValidationError({ field: "value", reason: "must be a string" });
  }
  const lowered = value.toLowerCase().trim();
  // Strip combining marks (accents).
  const stripped = lowered.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Collapse internal whitespace runs to single space.
  return stripped.replace(/\s+/g, " ");
}

/**
 * Digit-only normalizer for blind-indexing phone numbers. Strips all
 * non-digits then keeps at most the last 10 (the standard US "search
 * key" subset). Returns "" for inputs with no digits.
 */
export function normalizePhoneForBlindIndex(value: string): string {
  if (typeof value !== "string") {
    throw cryptoValidationError({ field: "value", reason: "must be a string" });
  }
  const digits = value.replace(/\D+/g, "");
  if (digits.length === 0) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export interface BlindIndexInput {
  readonly value: string;
  readonly binding: {
    readonly tenantId: string;
    readonly table: string;
    readonly column: string;
  };
  /**
   * Override the default text normalizer. Use for phone, NDC, ZIP,
   * etc. Default is `normalizeForBlindIndex`.
   */
  readonly normalize?: (raw: string) => string;
}

/**
 * Computes the blind index for `value` using the per-tenant search
 * key derived from the configured KMS. Returns the base64url-encoded
 * 32-byte HMAC-SHA256 digest.
 *
 * Returns `null` if normalization produces an empty string — that
 * signals "don't store a blind index" so callers can leave the
 * column NULL and avoid a SELECT … WHERE _bid = '' match against
 * every NULL-equivalent row.
 */
export async function blindIndex(input: BlindIndexInput): Promise<string | null> {
  const normalizer = input.normalize ?? normalizeForBlindIndex;
  const normalized = normalizer(input.value);
  if (normalized.length === 0) return null;

  const config = getCryptoConfiguration();
  const key = await config.kms.deriveSearchKey({
    tenantId: input.binding.tenantId,
    purpose: `${input.binding.table}.${input.binding.column}`,
  });
  try {
    const digest = createHmac("sha256", key).update(normalized, "utf8").digest();
    return digest.toString("base64url");
  } finally {
    key.fill(0);
  }
}
