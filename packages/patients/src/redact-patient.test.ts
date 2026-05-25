// Redaction invariants.
//
// Two complementary properties are pinned here:
//
//   1. The function's OUTPUT contains only allow-listed fields. We
//      construct a row that includes every PHI column the schema
//      knows about (with sentinel values) and assert no sentinel
//      shows up in the redacted projection.
//
//   2. The DENY LIST is complete vs. the Prisma model. We use
//      Prisma's `dmmf` to enumerate every `Patient` column and
//      assert that every PHI-shaped column (suffix `Enc` / `Bi`)
//      is in `PATIENT_REDACTED_FIELD_NAMES`. A schema change that
//      adds `socialSecurityNumberEnc` triggers this test BEFORE the
//      column lands in production.

import { Prisma } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import { PATIENT_REDACTED_FIELD_NAMES, redactPatient } from "./redact-patient.js";

const NOW = new Date("2026-01-15T12:00:00Z");
const NOT_PHI_SENTINEL = "0000-AAAA-NOT-PHI";
const PHI_SENTINEL = "0000-AAAA-PHI-LEAK";

/** Construct a "Patient row" with every PHI column populated by the
 * PHI sentinel and every non-PHI column populated by the safe one. */
function buildPatientWithSentinels(): Record<string, unknown> {
  return {
    id: NOT_PHI_SENTINEL,
    organizationId: NOT_PHI_SENTINEL,
    clinicId: NOT_PHI_SENTINEL,
    status: "ACTIVE" as const,
    cryptoShreddedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    mergedIntoPatientId: PHI_SENTINEL,
    firstNameEnc: { v: PHI_SENTINEL },
    lastNameEnc: { v: PHI_SENTINEL },
    dateOfBirthEnc: { v: PHI_SENTINEL },
    middleNameEnc: { v: PHI_SENTINEL },
    sexAtBirthEnc: { v: PHI_SENTINEL },
    ssnLast4Enc: { v: PHI_SENTINEL },
    phoneEnc: { v: PHI_SENTINEL },
    emailEnc: { v: PHI_SENTINEL },
    addressLine1Enc: { v: PHI_SENTINEL },
    addressLine2Enc: { v: PHI_SENTINEL },
    cityEnc: { v: PHI_SENTINEL },
    stateEnc: { v: PHI_SENTINEL },
    postalCodeEnc: { v: PHI_SENTINEL },
    mrnEnc: { v: PHI_SENTINEL },
    lastNameBi: PHI_SENTINEL,
    firstNameBi: PHI_SENTINEL,
    dobBi: PHI_SENTINEL,
    dobYearMonthBi: PHI_SENTINEL,
    phoneLast10Bi: PHI_SENTINEL,
    emailBi: PHI_SENTINEL,
    postalCodeBi: PHI_SENTINEL,
    mrnBi: PHI_SENTINEL,
  };
}

describe("redactPatient", () => {
  it("returns the allow-listed fields with the input values", () => {
    const row = buildPatientWithSentinels();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redacted = redactPatient(row as any);

    expect(redacted).toEqual({
      id: NOT_PHI_SENTINEL,
      organizationId: NOT_PHI_SENTINEL,
      clinicId: NOT_PHI_SENTINEL,
      status: "ACTIVE",
      cryptoShreddedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("never returns a PHI sentinel anywhere in the projection", () => {
    const row = buildPatientWithSentinels();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redacted = redactPatient(row as any);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(PHI_SENTINEL);
  });

  it("output has no inherited (proto) keys that leak PHI", () => {
    const row = buildPatientWithSentinels();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redacted = redactPatient(row as any);
    // `JSON.stringify` only emits own enumerable keys, but stringify
    // is exactly what audit shippers do — so this is the right check.
    const keys = new Set(Object.keys(redacted));
    for (const phiField of PATIENT_REDACTED_FIELD_NAMES) {
      expect(keys.has(phiField)).toBe(false);
    }
  });
});

describe("PATIENT_REDACTED_FIELD_NAMES — deny-list completeness", () => {
  // The Prisma model name for the `patient` table.
  const PATIENT_MODEL = Prisma.dmmf.datamodel.models.find((m) => m.name === "Patient");

  it("Patient model is present in the Prisma dmmf", () => {
    expect(PATIENT_MODEL, "schema regression: Patient model not found in dmmf").toBeDefined();
  });

  it("every *Enc and *Bi column on Patient is in the deny-list", () => {
    expect(PATIENT_MODEL).toBeDefined();
    if (PATIENT_MODEL === undefined) return;

    const missing: string[] = [];
    for (const field of PATIENT_MODEL.fields) {
      const isPhiShape = field.name.endsWith("Enc") || field.name.endsWith("Bi");
      if (!isPhiShape) continue;
      if (!PATIENT_REDACTED_FIELD_NAMES.has(field.name)) missing.push(field.name);
    }

    expect(
      missing,
      `add the following column(s) to PATIENT_REDACTED_FIELD_NAMES: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("every deny-listed name corresponds to a real Patient field", () => {
    expect(PATIENT_MODEL).toBeDefined();
    if (PATIENT_MODEL === undefined) return;

    const fieldSet = new Set(PATIENT_MODEL.fields.map((f) => f.name));
    const ghosts: string[] = [];
    for (const name of PATIENT_REDACTED_FIELD_NAMES) {
      if (!fieldSet.has(name)) ghosts.push(name);
    }
    expect(
      ghosts,
      `remove the following stale entries from PATIENT_REDACTED_FIELD_NAMES: ${ghosts.join(", ")}`
    ).toEqual([]);
  });
});
