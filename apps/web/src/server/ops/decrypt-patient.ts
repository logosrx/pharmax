// Server-side helper that decrypts a Patient row into a
// PatientPlaintext-shaped projection.
//
// Same per-field `tryDecrypt` pattern as `get-order-detail.ts` and
// `audit-patient-view.ts` — any per-envelope failure produces a
// null for that single field and flips a `phiDecryptErrors` flag
// rather than aborting the whole render. Partial display with a
// red banner is more useful to an admin than a generic 500.
//
// PHI rule: the returned plaintext is in-memory only. Callers
// MUST render it through `<dd>` cells (no data-attributes, no
// hidden form props that leak to client bundles) and dispatch a
// `ViewPatient` audit BEFORE rendering. The caller's `surface`
// parameter ensures the audit metadata distinguishes admin reads
// from order-detail reads.

import "server-only";

import { decryptField } from "@pharmax/crypto";

interface PatientEncryptedRow {
  readonly firstNameEnc: unknown;
  readonly lastNameEnc: unknown;
  readonly middleNameEnc: unknown;
  readonly dateOfBirthEnc: unknown;
  readonly sexAtBirthEnc: unknown;
  readonly ssnLast4Enc: unknown;
  readonly phoneEnc: unknown;
  readonly emailEnc: unknown;
  readonly addressLine1Enc: unknown;
  readonly addressLine2Enc: unknown;
  readonly cityEnc: unknown;
  readonly stateEnc: unknown;
  readonly postalCodeEnc: unknown;
  readonly mrnEnc: unknown;
}

/**
 * Decrypted patient identity fields. Distinct from
 * `@pharmax/patients`'s `PatientPlaintext` because we don't
 * carry the structural columns (id, status, timestamps) — those
 * come straight off the row.
 */
export interface DecryptedPatientFields {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly middleName: string | null;
  readonly dateOfBirth: string | null;
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
}

export interface DecryptedPatientResult {
  readonly fields: DecryptedPatientFields;
  /** True iff one or more envelopes failed to decrypt (KMS issue
   * or envelope corruption; caller renders an incident banner). */
  readonly phiDecryptErrors: boolean;
}

async function tryDecrypt(input: {
  envelope: unknown;
  binding: { tenantId: string; table: string; column: string; recordId: string };
}): Promise<{ value: string | null; ok: boolean }> {
  if (input.envelope === null || input.envelope === undefined) {
    return { value: null, ok: true };
  }
  try {
    const plain = await decryptField({
      envelope: input.envelope as Parameters<typeof decryptField>[0]["envelope"],
      binding: input.binding,
    });
    return { value: plain, ok: true };
  } catch {
    return { value: null, ok: false };
  }
}

export async function decryptPatientFields(input: {
  readonly organizationId: string;
  readonly patientId: string;
  readonly row: PatientEncryptedRow;
}): Promise<DecryptedPatientResult> {
  const bind = (column: string) =>
    ({
      tenantId: input.organizationId,
      table: "patient",
      column,
      recordId: input.patientId,
    }) as const;

  const [
    firstName,
    lastName,
    middleName,
    dateOfBirth,
    sexAtBirth,
    ssnLast4,
    phone,
    email,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    mrn,
  ] = await Promise.all([
    tryDecrypt({ envelope: input.row.firstNameEnc, binding: bind("firstName") }),
    tryDecrypt({ envelope: input.row.lastNameEnc, binding: bind("lastName") }),
    tryDecrypt({ envelope: input.row.middleNameEnc, binding: bind("middleName") }),
    tryDecrypt({ envelope: input.row.dateOfBirthEnc, binding: bind("dateOfBirth") }),
    tryDecrypt({ envelope: input.row.sexAtBirthEnc, binding: bind("sexAtBirth") }),
    tryDecrypt({ envelope: input.row.ssnLast4Enc, binding: bind("ssnLast4") }),
    tryDecrypt({ envelope: input.row.phoneEnc, binding: bind("phone") }),
    tryDecrypt({ envelope: input.row.emailEnc, binding: bind("email") }),
    tryDecrypt({ envelope: input.row.addressLine1Enc, binding: bind("addressLine1") }),
    tryDecrypt({ envelope: input.row.addressLine2Enc, binding: bind("addressLine2") }),
    tryDecrypt({ envelope: input.row.cityEnc, binding: bind("city") }),
    tryDecrypt({ envelope: input.row.stateEnc, binding: bind("state") }),
    tryDecrypt({ envelope: input.row.postalCodeEnc, binding: bind("postalCode") }),
    tryDecrypt({ envelope: input.row.mrnEnc, binding: bind("mrn") }),
  ]);

  const phiDecryptErrors = [
    firstName,
    lastName,
    middleName,
    dateOfBirth,
    sexAtBirth,
    ssnLast4,
    phone,
    email,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    mrn,
  ].some((d) => !d.ok);

  return {
    fields: Object.freeze({
      firstName: firstName.value,
      lastName: lastName.value,
      middleName: middleName.value,
      dateOfBirth: dateOfBirth.value,
      sexAtBirth: sexAtBirth.value,
      ssnLast4: ssnLast4.value,
      phone: phone.value,
      email: email.value,
      addressLine1: addressLine1.value,
      addressLine2: addressLine2.value,
      city: city.value,
      state: state.value,
      postalCode: postalCode.value,
      mrn: mrn.value,
    }),
    phiDecryptErrors,
  };
}
