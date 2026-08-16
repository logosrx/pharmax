// Synthetic payload builders for the Pharmax k6 suite.
//
// COMPLIANCE: every value here is obviously fake. No real patient,
// provider, drug, or clinic data may ever appear in this file or in
// the env vars it reads (.cursor/rules/02-security-compliance.mdc).
// The clinic/patient/provider UUIDs come from a synthetic staging seed
// and are injected via env vars — they are ids of fake records, not
// PHI, but they are environment-specific so they still do not belong
// in the repo.

/* global __ENV */

/**
 * The staging seed identifiers a valid CreatePrescription payload
 * needs. The command validates that the patient exists, is ACTIVE, and
 * belongs to the clinic, and that the provider exists and is ACTIVE
 * (packages/orders/src/commands/create-prescription.ts) — so these
 * must reference real rows in the staging tenant's synthetic seed.
 */
export function requireSeedIdentifiers() {
  const clinicId = __ENV.PHARMAX_SEED_CLINIC_ID || "";
  const patientId = __ENV.PHARMAX_SEED_PATIENT_ID || "";
  const providerId = __ENV.PHARMAX_SEED_PROVIDER_ID || "";
  if (clinicId === "" || patientId === "" || providerId === "") {
    throw new Error(
      "PHARMAX_SEED_CLINIC_ID, PHARMAX_SEED_PATIENT_ID and " +
        "PHARMAX_SEED_PROVIDER_ID must all be set to UUIDs from the " +
        "staging synthetic seed (an ACTIVE patient belonging to the " +
        "clinic, and an ACTIVE provider). See load/README.md."
    );
  }
  return { clinicId, patientId, providerId };
}

/**
 * A syntactically valid 11-digit NDC in a reserved-looking labeler
 * range that will never be in the product catalog. Because the NDC is
 * uncatalogued, the command REQUIRES an explicit
 * controlledSubstanceSchedule — we always declare NON_CONTROLLED so no
 * DEA/refill gate is in play and no prescriber DEA number is needed.
 */
export function syntheticNdc() {
  const suffix = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `99999${suffix}`;
}

/** Today as the YYYY-MM-DD calendar date the schema expects (UTC). */
export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A valid CreatePrescription input (the strict zod schema in
 * packages/orders/src/commands/create-prescription.ts):
 *
 *   - decimal fields are STRINGS (DECIMAL columns; IEEE-754 survival),
 *   - originalDateWritten is a YYYY-MM-DD calendar date,
 *   - the structured sig is a coherent FIXED shape whose arithmetic
 *     passes the days-supply cross-check (30 units / (1 x 1 per day)
 *     = 30 days = daysSupply exactly),
 *   - drug identity and sig text are loudly synthetic.
 */
export function prescriptionPayload(seed) {
  return {
    clinicId: seed.clinicId,
    patientId: seed.patientId,
    providerId: seed.providerId,
    drugNdc: syntheticNdc(),
    drugName: "ZZ-LOADTEST SYNTHETIC CAPSULE (DO NOT DISPENSE)",
    drugStrength: "10 mg",
    drugForm: "capsule",
    controlledSubstanceSchedule: "NON_CONTROLLED",
    quantityAuthorized: "30",
    daysSupply: 30,
    refillsAuthorized: 0,
    originalDateWritten: todayUtc(),
    daw: 0,
    sig: "K6 LOAD TEST - NOT A REAL PRESCRIPTION. Take 1 capsule by mouth daily.",
    sigStructureKind: "FIXED",
    doseAmount: "1",
    doseUnit: "CAPSULE",
    dosesPerDay: "1",
    noteToPharmacist: "Synthetic load-test record for patient 'Test Patient'. Do not fill.",
  };
}
