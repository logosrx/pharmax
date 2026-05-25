// Blind-index purpose registry.
//
// `@pharmax/crypto::blindIndex` derives a per-tenant search key from
// `(tenantId, "table.column")` (the "purpose" string). This file is
// the canonical list of (table, column) pairs that the phase-2
// patient/Rx/order schema uses so:
//
//   1. Schema reviewers can see at a glance which columns are
//      blind-indexed and which `*Bi` columns they correspond to.
//   2. Repository code can import a typed constant instead of
//      passing magic strings, eliminating typo-driven cross-purpose
//      collisions ("patient.email" vs "patient.Email").
//   3. KMS rotation tooling has one place to enumerate every search
//      key that needs to exist for a given tenant.
//
// Invariants enforced by code review (NOT by the type system; the
// crypto API takes free-form strings to keep `@pharmax/crypto`
// schema-agnostic):
//
//   * A new `*Bi` column REQUIRES a new entry here.
//   * The string is `<table>.<column>` where `<column>` is the name
//     of the PLAINTEXT field the BI represents, NOT the `*Bi` column
//     name. e.g. `patient.lastName`, not `patient.lastNameBi`.
//   * Never reuse a purpose for a different normalizer (a phone BI
//     and a text BI MUST live under different purposes — they hash
//     different inputs).

/**
 * Tuple shape: `[purpose, normalizerHint, biColumn]`.
 *
 * - `purpose`        — passed to `blindIndex` as `binding.purpose`
 *                      (currently derived from `table.column` by the
 *                      crypto adapter; this string MUST match that
 *                      derivation).
 * - `normalizerHint` — informational only; tells reviewers and
 *                      repository authors which normalizer to use.
 *                      `"text"` → `normalizeForBlindIndex`,
 *                      `"phone"` → `normalizePhoneForBlindIndex`,
 *                      `"raw"` → caller normalizes (e.g. DOB).
 * - `biColumn`       — the `*Bi` column the hash is stored in. Used
 *                      by tests and schema docs.
 */
export interface BlindIndexBinding {
  readonly purpose: string;
  readonly normalizer: "text" | "phone" | "raw";
  readonly biColumn: string;
}

function binding(
  table: string,
  column: string,
  normalizer: BlindIndexBinding["normalizer"],
  biColumn: string
): BlindIndexBinding {
  return {
    purpose: `${table}.${column}`,
    normalizer,
    biColumn,
  };
}

export const PATIENT_BLIND_INDEX_BINDINGS = {
  lastName: binding("patient", "lastName", "text", "lastNameBi"),
  firstName: binding("patient", "firstName", "text", "firstNameBi"),
  // Caller normalizes DOB to YYYYMMDD (full DOB).
  dateOfBirth: binding("patient", "dateOfBirth", "raw", "dobBi"),
  // Caller normalizes to YYYYMM (year+month only). Distinct purpose
  // from `dateOfBirth` so the keys don't collide even though both
  // are derived from the same plaintext.
  dateOfBirthYearMonth: binding("patient", "dateOfBirthYearMonth", "raw", "dobYearMonthBi"),
  phoneLast10: binding("patient", "phone", "phone", "phoneLast10Bi"),
  email: binding("patient", "email", "text", "emailBi"),
  postalCode: binding("patient", "postalCode", "text", "postalCodeBi"),
  mrn: binding("patient", "mrn", "text", "mrnBi"),
} as const;

export const PRESCRIPTION_BLIND_INDEX_BINDINGS = {
  rxNumber: binding("prescription", "rxNumber", "text", "rxNumberBi"),
} as const;

/**
 * Flat enumeration of every blind-index purpose the schema currently
 * uses. Convenient for KMS rotation jobs ("derive a search key for
 * every purpose"); tests can also use this to assert that every
 * `*Bi` column in the schema has a registered purpose.
 */
export const ALL_BLIND_INDEX_BINDINGS: readonly BlindIndexBinding[] = [
  ...Object.values(PATIENT_BLIND_INDEX_BINDINGS),
  ...Object.values(PRESCRIPTION_BLIND_INDEX_BINDINGS),
];
