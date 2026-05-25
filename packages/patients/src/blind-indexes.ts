// Patient blind-index helpers.
//
// `@pharmax/crypto::blindIndex` is the primitive — given a (tenantId,
// table, column) binding and a normalized plaintext, it returns the
// 43-char base64url HMAC stored in a `*Bi` column. This file applies
// the patient-specific normalization and binding rules so callers
// (intake, merge, search) don't have to reproduce the rules in three
// places.
//
// Three rules govern everything below:
//
//   1. Bindings come from `PATIENT_BLIND_INDEX_BINDINGS` (in
//      `@pharmax/database`), not free-form strings. A typo would
//      compute a different search key and silently break search.
//
//   2. DOB normalization is done HERE, not in `@pharmax/crypto`. The
//      crypto package is schema-agnostic; expecting it to know about
//      `YYYYMMDD` vs `YYYY-MM-DD` would couple it to this domain.
//
//   3. Empty / invalid inputs return `null`, never throw. Search
//      with an empty surname becomes "skip the surname filter", not
//      "everyone with surname '' " — the SQL-side index would
//      otherwise match every NULL row.

import { blindIndex, normalizePhoneForBlindIndex, type BlindIndexInput } from "@pharmax/crypto";
import { phi } from "@pharmax/database";

const PATIENT_BLIND_INDEX_BINDINGS = phi.PATIENT_BLIND_INDEX_BINDINGS;

/**
 * The set of normalized DOB shapes we accept. Callers can pass any
 * of these and the function will pick the right one. Anything else
 * is rejected with `null` (don't throw — search should degrade
 * gracefully when an upstream form has a malformed value).
 */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;

/** Strip a `YYYY-MM-DD` to its `YYYYMMDD` blind-index input. */
export function normalizeDobForBlindIndex(value: string): string | null {
  const match = ISO_DATE_RE.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return `${match[1]}${match[2]}${match[3]}`;
}

/** Strip a `YYYY-MM` to its `YYYYMM` blind-index input. */
export function normalizeDobYearMonthForBlindIndex(value: string): string | null {
  const match = ISO_YEAR_MONTH_RE.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  return `${match[1]}${match[2]}`;
}

/**
 * Per-binding blind-index entry-points. Each returns `null` when the
 * input normalizes to empty (so search callers can drop the field
 * from their `where` clause). All names match the keys in
 * `PATIENT_BLIND_INDEX_BINDINGS`.
 */
export const PATIENT_BLIND_INDEX = {
  async lastName(args: { tenantId: string; value: string }): Promise<string | null> {
    return blindIndex(toBindingInput(PATIENT_BLIND_INDEX_BINDINGS.lastName.purpose, args));
  },

  async firstName(args: { tenantId: string; value: string }): Promise<string | null> {
    return blindIndex(toBindingInput(PATIENT_BLIND_INDEX_BINDINGS.firstName.purpose, args));
  },

  /**
   * Full DOB blind index. `value` MUST be `YYYY-MM-DD`. Returns
   * `null` if normalization rejects the input.
   */
  async dateOfBirth(args: { tenantId: string; value: string }): Promise<string | null> {
    const normalized = normalizeDobForBlindIndex(args.value);
    if (normalized === null) return null;
    return blindIndex(
      toRawBindingInput(PATIENT_BLIND_INDEX_BINDINGS.dateOfBirth.purpose, {
        tenantId: args.tenantId,
        value: normalized,
      })
    );
  },

  /**
   * Year+month DOB blind index. `value` MUST be `YYYY-MM`. Returns
   * `null` if normalization rejects the input. Useful for "user
   * typo'd the day" patient lookups.
   */
  async dateOfBirthYearMonth(args: { tenantId: string; value: string }): Promise<string | null> {
    const normalized = normalizeDobYearMonthForBlindIndex(args.value);
    if (normalized === null) return null;
    return blindIndex(
      toRawBindingInput(PATIENT_BLIND_INDEX_BINDINGS.dateOfBirthYearMonth.purpose, {
        tenantId: args.tenantId,
        value: normalized,
      })
    );
  },

  /**
   * Phone blind index. Digits-only, last-10 normalization is applied
   * by `@pharmax/crypto::normalizePhoneForBlindIndex`.
   */
  async phoneLast10(args: { tenantId: string; value: string }): Promise<string | null> {
    return blindIndex({
      value: args.value,
      binding: bindingFromPurpose(PATIENT_BLIND_INDEX_BINDINGS.phoneLast10.purpose, args.tenantId),
      normalize: normalizePhoneForBlindIndex,
    });
  },

  async email(args: { tenantId: string; value: string }): Promise<string | null> {
    return blindIndex(toBindingInput(PATIENT_BLIND_INDEX_BINDINGS.email.purpose, args));
  },

  async postalCode(args: { tenantId: string; value: string }): Promise<string | null> {
    return blindIndex(toBindingInput(PATIENT_BLIND_INDEX_BINDINGS.postalCode.purpose, args));
  },

  async mrn(args: { tenantId: string; value: string }): Promise<string | null> {
    return blindIndex(toBindingInput(PATIENT_BLIND_INDEX_BINDINGS.mrn.purpose, args));
  },
} as const;

// ---------------------------------------------------------------------
// Helpers

/**
 * Build the `BlindIndexInput` shape `@pharmax/crypto::blindIndex`
 * expects. The crypto layer parses `purpose` back into `(table,
 * column)` so we round-trip through `bindingFromPurpose`.
 */
function toBindingInput(
  purpose: string,
  args: { tenantId: string; value: string }
): BlindIndexInput {
  return {
    value: args.value,
    binding: bindingFromPurpose(purpose, args.tenantId),
  };
}

/** Same as `toBindingInput` but bypasses the default text normalizer. */
function toRawBindingInput(
  purpose: string,
  args: { tenantId: string; value: string }
): BlindIndexInput {
  return {
    value: args.value,
    binding: bindingFromPurpose(purpose, args.tenantId),
    // Identity normalizer: the caller already shaped the input.
    normalize: (raw) => raw,
  };
}

/**
 * Parse a `table.column` purpose string into the `{ tenantId,
 * table, column }` binding the crypto layer wants. The dot is the
 * delimiter; no dots are allowed inside table or column names.
 */
function bindingFromPurpose(purpose: string, tenantId: string): BlindIndexInput["binding"] {
  const dot = purpose.indexOf(".");
  if (dot === -1) {
    throw new Error(
      `@pharmax/patients: invalid blind-index purpose ${JSON.stringify(purpose)} (expected "table.column")`
    );
  }
  return {
    tenantId,
    table: purpose.slice(0, dot),
    column: purpose.slice(dot + 1),
  };
}
