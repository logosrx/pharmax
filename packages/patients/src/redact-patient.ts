// PHI-safe Patient projection for logs, audit metadata, webhooks.
//
// This is the ONLY function in the platform allowed to take a Patient
// row and produce a value that goes into a string log line, an audit
// metadata blob, an outbox payload, or any external sink.
//
// Why a dedicated function (not "just pick the fields you need"):
//
//   * One file to read in a SOC 2 audit. Reviewers can see the exact
//     allow-list of fields that ever leave the boundary.
//   * Adding a column to Patient that DOESN'T appear here is the
//     default-safe outcome. If someone adds a "shoeSize" column, it's
//     invisible to logs unless this file is changed.
//   * The unit test in `redact-patient.test.ts` enumerates every
//     forbidden column name and asserts the redacted projection
//     does not contain it. A schema change that adds a new PHI
//     column triggers a test failure in this package, forcing the
//     author to extend the deny-list.
//
// Inputs we expect: rows produced by Prisma's `findUnique` /
// `findMany` on the Patient model. We don't constrain the input type
// further than "has these fields" so callers can pass either a
// plaintext shape or a raw row (the function only touches the
// non-PHI columns).

import type { RedactedPatient } from "./types.js";

/**
 * Structural type of a Patient-shaped input. Defined as the
 * intersection of "the non-PHI fields we extract" + "an open record"
 * so callers can pass either a full Prisma row (with `*Enc`/`*Bi`)
 * or a `PatientPlaintext`. Extra fields are ignored.
 */
export interface RedactablePatient {
  readonly id: string;
  readonly organizationId: string;
  readonly clinicId: string;
  readonly status: RedactedPatient["status"];
  readonly cryptoShreddedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Produce a log-safe projection of a Patient.
 *
 * The result is a fresh object containing only allow-listed fields.
 * The input is not mutated; the output has no `__proto__` link to
 * the input so a JSON.stringify cycle on the output won't accidentally
 * pull in inherited PHI properties from the source.
 */
export function redactPatient(input: RedactablePatient): RedactedPatient {
  return {
    id: input.id,
    organizationId: input.organizationId,
    clinicId: input.clinicId,
    status: input.status,
    cryptoShreddedAt: input.cryptoShreddedAt,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

/**
 * Enumeration of EVERY Patient column that MUST be excluded from a
 * redacted projection. Kept here (not in `types.ts`) so the unit
 * test and the redactor share one list. If a schema change adds a
 * PHI column, extend this list AND the schema; the test will fail
 * until both happen.
 *
 * Categories (alphabetical inside each block):
 *
 *   * `*Enc` — envelope-encrypted JSON. Even though the value is
 *     ciphertext, we treat it as PHI by convention; ciphertext in a
 *     log line still aids correlation attacks across log sinks.
 *
 *   * `*Bi` — blind-index HMAC. Per-tenant key separation makes the
 *     hash useless for queries from a different tenant, but the
 *     value still uniquely identifies the underlying plaintext
 *     within the tenant. Treat as PHI.
 *
 *   * `mergedIntoPatientId` — points to another Patient row. Not
 *     itself PHI, but exposing the merge graph to logs adds an
 *     identity-linking vector. Defer to the merge-specific audit
 *     event for that information.
 */
export const PATIENT_REDACTED_FIELD_NAMES: ReadonlySet<string> = new Set([
  "firstNameEnc",
  "lastNameEnc",
  "dateOfBirthEnc",
  "middleNameEnc",
  "sexAtBirthEnc",
  "ssnLast4Enc",
  "phoneEnc",
  "emailEnc",
  "addressLine1Enc",
  "addressLine2Enc",
  "cityEnc",
  "stateEnc",
  "postalCodeEnc",
  "mrnEnc",
  "lastNameBi",
  "firstNameBi",
  "dobBi",
  "dobYearMonthBi",
  "phoneLast10Bi",
  "emailBi",
  "postalCodeBi",
  "mrnBi",
  "mergedIntoPatientId",
]);
