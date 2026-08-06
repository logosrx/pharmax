// The allergy vocabulary, and the one question every caller has to ask
// about a stored allergy before it means anything: WILL THIS RECORD
// ACTUALLY BE COMPARED TO SOMETHING?
//
// -------------------------------------------------------------------
// Why this module exists at all
// -------------------------------------------------------------------
//
// Because two packages have to answer that question and give the same
// answer, and neither may import the other.
//
//   - `@pharmax/verification` decides `ScreeningInputAvailability` for
//     the DRUG_ALLERGY axis. It must say AVAILABLE only when it is
//     about to hand the engine at least one record the engine can use.
//     Say AVAILABLE and pass records that all get skipped, and the
//     screen reports a clean allergy check that never happened —
//     which is the exact failure `SCREENING_INPUT_AVAILABILITIES`
//     exists to make unrepresentable, reintroduced one layer up.
//   - `@pharmax/patients` reports on the same property when it records
//     a row, because "we hold three allergies for this patient" and
//     "the screen can use none of them" are different operational
//     facts and a coverage report that conflated them would overstate
//     the safety net.
//
// Both are domain packages, so `check-package-layers.ts` forbids an
// edge between them. Duplicating the predicate would work right up
// until somebody adds a category or a code system to one copy. So it
// lives here, in the package that is below both and that owns the
// screening semantics in the first place.
//
// CLEAN ROOM: the vocabulary is HL7 FHIR R4 `AllergyIntolerance`
// (https://hl7.org/fhir/R4/allergyintolerance.html) — `category`,
// `type`, `criticality`, `verificationStatus`, `clinicalStatus`.
// Nothing here is derived from any vendor's model.

/** FHIR `AllergyIntolerance.category`. */
export const ALLERGY_CATEGORIES = Object.freeze([
  "MEDICATION",
  "BIOLOGIC",
  "FOOD",
  "ENVIRONMENT",
] as const);

export type AllergyCategory = (typeof ALLERGY_CATEGORIES)[number];

/**
 * FHIR `AllergyIntolerance.type`. An intolerance is a non-immune
 * adverse reaction — real and worth surfacing, but not the
 * anaphylaxis risk that could justify refusing to dispense.
 */
export const ALLERGY_TYPES = Object.freeze(["ALLERGY", "INTOLERANCE"] as const);

export type AllergyType = (typeof ALLERGY_TYPES)[number];

/** FHIR `AllergyIntolerance.criticality`. */
export const ALLERGY_CRITICALITIES = Object.freeze(["HIGH", "LOW", "UNABLE_TO_ASSESS"] as const);

export type AllergyCriticality = (typeof ALLERGY_CRITICALITIES)[number];

/** FHIR `AllergyIntolerance.verificationStatus`. */
export const ALLERGY_VERIFICATION_STATUSES = Object.freeze([
  "CONFIRMED",
  "UNCONFIRMED",
  "REFUTED",
  "ENTERED_IN_ERROR",
] as const);

export type AllergyVerificationStatus = (typeof ALLERGY_VERIFICATION_STATUSES)[number];

/**
 * FHIR `AllergyIntolerance.clinicalStatus` — whether the propensity
 * still exists.
 *
 * Not part of `RecordedAllergy` and deliberately not filtered inside
 * the engine: it is the STORE's lifecycle field, and the caller that
 * owns the store is the one that knows an INACTIVE row should not be
 * handed over. The engine keeps its own category and verification
 * filters as defence in depth against a caller that forgets, but it
 * cannot defend against a field it is never shown.
 */
export const ALLERGY_CLINICAL_STATUSES = Object.freeze(["ACTIVE", "INACTIVE", "RESOLVED"] as const);

export type AllergyClinicalStatus = (typeof ALLERGY_CLINICAL_STATUSES)[number];

/**
 * Drug knowledge answers drug questions. Food and environmental
 * allergies are clinically real but unanswerable here, and screening
 * them would produce a permanent gap finding on every prescription for
 * any patient with a shellfish allergy on file. Excluded at the door.
 */
export function isScreenableAllergyCategory(category: AllergyCategory): boolean {
  switch (category) {
    case "MEDICATION":
    case "BIOLOGIC":
      return true;
    case "FOOD":
    case "ENVIRONMENT":
      return false;
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

/**
 * A refuted or erroneously entered allergy is a record the pharmacy
 * has actively decided is wrong. Screening against it would resurrect
 * a correction someone already made.
 */
export function isScreenableAllergyVerificationStatus(status: AllergyVerificationStatus): boolean {
  switch (status) {
    case "CONFIRMED":
    case "UNCONFIRMED":
      return true;
    case "REFUTED":
    case "ENTERED_IN_ERROR":
      return false;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * Only an ACTIVE propensity is screened.
 *
 * INACTIVE and RESOLVED records stay visible to a pharmacist — an
 * outgrown childhood penicillin allergy is worth seeing — but they are
 * statements that the risk no longer applies, and screening against
 * them would reinstate a judgement a clinician already retired.
 */
export function isScreenableAllergyClinicalStatus(status: AllergyClinicalStatus): boolean {
  switch (status) {
    case "ACTIVE":
      return true;
    case "INACTIVE":
    case "RESOLVED":
      return false;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * Which code space a recorded allergen is expressed in.
 *
 * Mirrors the `AllergySubstanceCodeSystem` Prisma enum member-for-member;
 * `packages/verification/src/screening/allergy-input.test.ts` asserts
 * the two are equal so a member added to one cannot go missing from the
 * other.
 */
export const ALLERGY_SUBSTANCE_CODE_SYSTEMS = Object.freeze([
  "RXNORM",
  "NDC",
  "SNOMED_CT",
  "PHARMAX_ALLERGEN_CLASS",
  "UNCODED",
] as const);

export type AllergySubstanceCodeSystem = (typeof ALLERGY_SUBSTANCE_CODE_SYSTEMS)[number];

/**
 * Whether an allergen recorded in this code space can be compared to
 * anything at all.
 *
 * THE SUBTLEST PART OF SCREENABILITY, and the one a first
 * implementation gets wrong. The engine compares substance codes to a
 * knowledge source's ingredient codes by string equality and owns no
 * code space of its own. A record whose allergen was never coded —
 * "sulfa", as the patient said it — cannot match anything. Pass it to
 * the engine anyway and the loop runs, finds no ingredient match, finds
 * no cross-sensitivity data, and contributes NOTHING. Nothing is
 * indistinguishable from clean.
 *
 * So an uncoded record is not screenable input. It remains a real
 * clinical record that the console must show, because for an uncoded
 * allergen a human reading the text is the only screen there is.
 *
 * Note this asks about the code SPACE, not about whether a particular
 * code is present in the knowledge source. A coded allergen the source
 * has never heard of is a knowledge gap, which the engine reports on
 * its own terms; that is a different question with a different owner.
 */
export function isComparableSubstanceCodeSystem(system: AllergySubstanceCodeSystem): boolean {
  switch (system) {
    case "RXNORM":
    case "NDC":
    case "SNOMED_CT":
    case "PHARMAX_ALLERGEN_CLASS":
      return true;
    case "UNCODED":
      return false;
    default: {
      const exhaustive: never = system;
      return exhaustive;
    }
  }
}

/**
 * Everything about one stored allergy that decides whether a screen can
 * do anything with it.
 *
 * Takes the code SYSTEM rather than a pre-computed "is it comparable?"
 * boolean on purpose: a boolean is a place for a caller to be wrong,
 * and being wrong in the true direction is what produces a clean
 * allergy screen that never compared anything.
 */
export interface AllergyScreenability {
  readonly category: AllergyCategory;
  readonly clinicalStatus: AllergyClinicalStatus;
  readonly verificationStatus: AllergyVerificationStatus;
  readonly substanceCodeSystem: AllergySubstanceCodeSystem;
}

/**
 * Whether this record will contribute to an allergy screen.
 *
 * Callers use it for two things that must not disagree: choosing which
 * records to hand the engine, and deciding whether the DRUG_ALLERGY
 * axis can honestly be declared AVAILABLE for a patient. If those two
 * ever answer differently, the axis claims a screen it did not run.
 */
export function isScreenableAllergy(record: AllergyScreenability): boolean {
  return (
    isComparableSubstanceCodeSystem(record.substanceCodeSystem) &&
    isScreenableAllergyCategory(record.category) &&
    isScreenableAllergyClinicalStatus(record.clinicalStatus) &&
    isScreenableAllergyVerificationStatus(record.verificationStatus)
  );
}
