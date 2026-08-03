// The drug-knowledge seam.
//
// CLEAN ROOM. Pharmax does not own, and must not embed, a drug
// knowledge base. Interaction tables, cross-sensitivity groupings and
// dose ranges published by the commercial clinical databases are
// licensed proprietary content; copying them — even "just the severity
// gradings" — is exactly the access-plus-similarity pattern that
// forfeits a clean-room defence. See
// `.cursor/rules/04-clean-room-policy.mdc` and
// `docs/governance/public-sources-reference.md`.
//
// So this package ships the QUESTIONS and none of the ANSWERS. The
// interface below is the entire contract a licensed database has to
// satisfy, behind an adapter that a customer's licence covers. The
// only implementation shipped here is an empty in-memory container the
// caller seeds itself (see `in-memory-knowledge-source.ts`), which
// contains no drug data of any kind.
//
// The shapes are modelled on public sources: HL7 FHIR R4
// `MedicationKnowledge` (a medication decomposes into ingredients and
// carries classification and dosing guidance) and `AllergyIntolerance`
// (a substance code that may denote an individual substance or a
// class). Nothing here is derived from any vendor's schema.
//
// TOTALITY. Every method returns a value or `null`; none throws and
// none is async. A lookup that cannot be answered returns `null`, and
// the engine turns that into a visible `SCREENING_GAP` finding rather
// than into silence. An adapter fronting a network service must
// therefore resolve its data BEFORE calling the engine — which is the
// point of the seam, since it keeps `screenPrescription` pure and
// replayable over `command_log`.

import type { ScreeningCertainty, ScreeningSeverity } from "./findings.js";

/**
 * Codes are opaque strings, compared only for equality. The engine
 * never parses them and never assumes a coding system, so a deployment
 * may key on RxNorm ingredient RXCUIs, NDC product codes, or an
 * adapter's own identifiers — provided it is internally consistent.
 * These aliases document intent; they are not branded types, because
 * the caller owns the code space and we cannot mint its values.
 */
export type DrugCode = string;
export type IngredientCode = string;
export type TherapeuticClassCode = string;
export type AllergenCode = string;
export type CrossSensitivityClassCode = string;

/**
 * A population-level dosing envelope for a drug.
 *
 * `unit` is compared by exact string equality against the prescribed
 * unit and never converted. Unit conversion inside a safety check is a
 * mistake waiting to happen — a wrong mg/mcg factor turns a screen
 * into a hazard — so a mismatch is reported as a gap and left to the
 * pharmacist.
 */
export interface DoseRange {
  readonly unit: string;
  readonly maxSingleDose: number | null;
  readonly maxDailyDose: number | null;
  /** Below this, the daily total is likely sub-therapeutic. */
  readonly minDailyDose: number | null;
  /** Provenance of the envelope, e.g. an FDA label section. */
  readonly citation: string | null;
}

/** What the engine needs to know about a dispensable drug. */
export interface DrugKnowledge {
  /**
   * Active ingredients. A combination product has several; interaction
   * and duplication screening both operate at this level, because that
   * is the level at which the pharmacology lives.
   */
  readonly ingredientCodes: ReadonlyArray<IngredientCode>;
  /** Therapeutic classes, for duplicate-therapy detection. */
  readonly therapeuticClassCodes: ReadonlyArray<TherapeuticClassCode>;
  /**
   * Classes that carry a cross-sensitivity risk — the groupings that
   * make an allergy to one member relevant to another.
   */
  readonly crossSensitivityClassCodes: ReadonlyArray<CrossSensitivityClassCode>;
  readonly doseRange: DoseRange | null;
}

/**
 * What the engine needs to know about a substance a patient has
 * reacted to. Separate from `DrugKnowledge` because an allergy is
 * routinely recorded against something that is not a dispensable
 * product — an ingredient, or a whole class.
 */
export interface AllergenKnowledge {
  readonly crossSensitivityClassCodes: ReadonlyArray<CrossSensitivityClassCode>;
}

/**
 * An asserted interaction between two ingredients.
 *
 * The knowledge source supplies severity and certainty; the engine
 * does not second-guess them, it only applies the disposition policy.
 * That split is deliberate — grading is the licensed database's
 * expertise, and hard-stop policy is ours.
 *
 * ADAPTER WARNING: `CONTRAINDICATED` together with `DEFINITE` is the
 * one grading an adapter can emit that produces an unoverridable
 * block. Reserve it for absolute contraindications — a combination
 * that should never be dispensed to anyone. Mapping a source's
 * top severity band onto it wholesale will block routine
 * prescriptions, and a pharmacy that meets an unoverridable alert it
 * disagrees with turns the screening off.
 */
export interface InteractionFact {
  readonly severity: ScreeningSeverity;
  readonly certainty: ScreeningCertainty;
  readonly citation: string | null;
}

/**
 * The seam. Implement this over a licensed clinical database, behind
 * an adapter, and the engine works unchanged.
 *
 * Implementer contract:
 *   - Pure and synchronous. No I/O, no clock, no throwing.
 *   - `findIngredientInteraction` MUST be symmetric: the answer for
 *     (a, b) and (b, a) must be identical. The engine enumerates pairs
 *     in profile order and does not normalise them, so an asymmetric
 *     implementation would make findings depend on the order rows came
 *     back from the database.
 *   - An unknown code returns `null`. Do not substitute an empty
 *     `DrugKnowledge`: "I have no record of this drug" and "this drug
 *     has no ingredients" are different claims, and the first one is
 *     the one that has to reach the pharmacist.
 */
export interface DrugKnowledgeSource {
  describeDrug(code: DrugCode): DrugKnowledge | null;
  describeAllergen(code: AllergenCode): AllergenKnowledge | null;
  findIngredientInteraction(a: IngredientCode, b: IngredientCode): InteractionFact | null;
}
