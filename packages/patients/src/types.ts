// Public types for @pharmax/patients.
//
// The package draws a hard line between two shapes:
//
//   1. `PatientPlaintext` — the decrypted, application-facing view.
//      The shape a UI or PDF generator wants. NEVER persist this.
//      NEVER log it.
//
//   2. The Prisma `Patient` row — the on-disk shape with envelope
//      JSON in every `*Enc` column and base64url HMAC in every `*Bi`
//      column. Hot path for storage and search; opaque to readers.
//
// Most code in the platform should consume only `PatientPlaintext`
// (after going through a decrypt step in a command handler / read
// model) or the redacted projection from `redact-patient.ts` (for
// logs, audit metadata, and outbound webhook payloads).

/**
 * Patient identity and contact fields in plaintext form.
 *
 * Field nullability mirrors the schema:
 *   - Required: id, organizationId, clinicId, firstName, lastName,
 *     dateOfBirth, status, createdAt, updatedAt.
 *   - Optional: every other field (middle name, SSN last 4, contact,
 *     address, MRN, merge pointer, crypto-shred state).
 *
 * `dateOfBirth` is an ISO date string in `YYYY-MM-DD` form. We
 * deliberately don't expose a JavaScript `Date` here — DOBs are
 * timezone-free and DOB arithmetic with `Date` is a notorious
 * footgun ("born at 23:00 UTC on Dec 31" rolls a day in EST).
 */
export interface PatientPlaintext {
  readonly id: string;
  readonly organizationId: string;
  readonly clinicId: string;

  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;

  readonly middleName: string | null;
  readonly sexAtBirth: string | null;
  readonly ssnLast4: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly mrn: string | null;

  readonly status: "ACTIVE" | "INACTIVE" | "DECEASED" | "MERGED";
  readonly mergedIntoPatientId: string | null;
  readonly cryptoShreddedAt: Date | null;

  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Log-safe projection of a Patient row.
 *
 * Contains ONLY:
 *   - id, organizationId, clinicId (identifiers + scope)
 *   - status, cryptoShreddedAt (operational state)
 *   - timestamps
 *
 * Anything that could leak PHI — names, DOB, contact, address,
 * MRN, even the blind-index columns — is dropped.
 *
 * The shape is intentionally narrow and stable so log shippers,
 * webhook adapters, and audit dashboards can rely on it.
 */
export interface RedactedPatient {
  readonly id: string;
  readonly organizationId: string;
  readonly clinicId: string;
  readonly status: PatientPlaintext["status"];
  readonly cryptoShreddedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Structured query for `searchPatients`. Every field is optional;
 * at least one must be set or the search refuses to run (we don't
 * dispense unbounded patient scans).
 *
 * Normalization rules — applied inside `searchPatients` before the
 * blind-index step — mirror the rules used by intake:
 *   - `firstName`, `lastName`, `email`, `postalCode`, `mrn`: NFD
 *     normalize, strip combining marks, lowercase, trim.
 *   - `phone`: digits-only; the last 10 are hashed.
 *   - `dateOfBirth`: must be `YYYY-MM-DD`; the hash is over the
 *     `YYYYMMDD` form.
 *   - `dateOfBirthYearMonth`: must be `YYYY-MM`; the hash is over
 *     the `YYYYMM` form. Useful for "typo'd DOB" recovery.
 */
export interface PatientSearchQuery {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly dateOfBirth?: string;
  readonly dateOfBirthYearMonth?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly postalCode?: string;
  readonly mrn?: string;
}

/**
 * Page of search results. Patients are returned with their full
 * encrypted row so callers can selectively decrypt the fields they
 * need (typeahead displays decrypt just the name; merge UI decrypts
 * names + DOB + contact). Decryption is the caller's responsibility
 * — this package never decrypts on behalf of a search.
 *
 * `total` is omitted on purpose: counting matches across a tenant's
 * patient population is expensive and is not what intake / merge
 * UIs need. Callers that genuinely need a count use a separate
 * `countPatients` call.
 */
export interface PatientSearchResult<TRow> {
  readonly rows: ReadonlyArray<TRow>;
  readonly tookMs: number;
}
