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

import type { ScreeningCertainty, ScreeningGapRemediation, ScreeningSeverity } from "./findings.js";

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
  /**
   * How many declared components of this drug the source KNOWS it
   * could not name in `ingredientCodes` — recipe rows nobody has
   * coded yet, for a source answering from an org-declared compound
   * formula. `0` for a source whose ingredient list is complete by
   * construction (a national product resolved from a published
   * release names every active ingredient or resolves nothing).
   *
   * REQUIRED, not defaulted, because the default answer is the unsafe
   * one: an adapter holding a partial list that omits this field
   * would let the engine read "screened these ingredients" as
   * "screened THE ingredients", which is the ambiguity
   * `SCREENING_GAP` findings exist to destroy. Any value above zero
   * makes the engine emit `SCR_COMPOUND_INGREDIENTS_PARTIALLY_CODED`
   * alongside whatever the coded subset produced.
   *
   * This is the engine's existing posture toward partial inputs —
   * "supply what it has and declare AVAILABLE" (see
   * `SCREENING_INPUT_AVAILABILITIES` on why PARTIAL is deliberately
   * not a state) — completed with the report that makes it honest.
   */
  readonly uncodedIngredientCount: number;
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
 * Whether this source has a body of knowledge to answer FROM.
 *
 * The same distinction `ScreeningInputAvailability` draws for caller
 * inputs, applied to the knowledge seam: `describeDrug` returning
 * `null` is one answer with two very different meanings, and the
 * engine has to be able to tell them apart.
 *
 *   - PROVISIONED, and a code is unknown: one row missing from a
 *     database that is otherwise answering. Somebody can act on that
 *     today — check the NDC is right, ask the vendor for an update —
 *     so the gap is worth a pharmacist's attention.
 *   - NOT_PROVISIONED: no database is wired, so EVERY lookup will
 *     return `null` for every drug on every order forever. Nobody in
 *     the pharmacy can close that, and reporting it interruptively on
 *     every prescription trains the dismiss reflex rather than
 *     informing anyone.
 *
 * DECLARED, NOT INFERRED, for a real adapter. An adapter must not
 * compute this from whether its last lookup succeeded; it knows at
 * construction whether it was given a licence and a dataset, and that
 * is the answer.
 */
export const DRUG_KNOWLEDGE_COVERAGES = Object.freeze(["PROVISIONED", "NOT_PROVISIONED"] as const);

export type DrugKnowledgeCoverage = (typeof DRUG_KNOWLEDGE_COVERAGES)[number];

/**
 * Project a coverage declaration onto the same "who can close this?"
 * axis that caller-input availability projects onto, so
 * `screeningGapSeverity` grades both families of gap by one rule.
 *
 * Lives here rather than beside `gapRemediationForAvailability` only
 * because `findings.ts` sits below this module and must not import
 * from it.
 */
export function gapRemediationForCoverage(
  coverage: DrugKnowledgeCoverage
): ScreeningGapRemediation {
  switch (coverage) {
    case "PROVISIONED":
      return "SUBJECT_DATA";
    case "NOT_PROVISIONED":
      return "PLATFORM_CAPABILITY";
    default: {
      const exhaustive: never = coverage;
      return exhaustive;
    }
  }
}

/**
 * Whether a code is even a member of the nomenclature this source
 * answers from.
 *
 * `describeDrug` returning `null` from a PROVISIONED source has,
 * until now, meant one thing: a row is missing from a database that
 * is otherwise answering, so a pharmacist is interrupted to "verify
 * the code and request a reference-data update". That instruction is
 * TRUE for a manufactured product's NDC and FALSE for a compounded
 * preparation: a compound carries an org-local identifier no national
 * nomenclature has ever contained, the code is correct as recorded,
 * and no reference-data update will ever resolve it. Interrupting on
 * it — on every order for every compound forever, in a platform built
 * for compounding pharmacies — is the alert-fatigue machine this
 * package exists to avoid, wearing the knowledge gap's clothes. And
 * the remediation text would be a lie.
 *
 * So the source, which owns the nomenclature, gets to say which of
 * the two situations a null answer is:
 *
 *   - IN_NOMENCLATURE: the code SHOULD resolve. A miss is a fixable
 *     hole — graded like a missing subject fact, worth a pharmacist's
 *     attention (`SCR_KNOWLEDGE_UNAVAILABLE`, acknowledge tier).
 *   - OUT_OF_NOMENCLATURE: the code was never going to resolve.
 *     Recorded without interrupting
 *     (`SCR_KNOWLEDGE_NOT_APPLICABLE`, informational), because
 *     closing it is a product capability — locally declared compound
 *     ingredients — not anything the pharmacist on this order can do.
 *
 * THE THIRD VALUE, for the source that can hold locally declared
 * ingredients (compound formulas coded by the org's own formulary
 * team):
 *
 *   - LOCALLY_DECLARABLE: the code is outside every national
 *     nomenclature AND the platform supports an org-declared
 *     ingredient list for it — the org just has not supplied one the
 *     screen can use (no ACTIVE formula claims the product, or the
 *     claiming formula has no coded rows). A miss here is closable,
 *     by the ORGANIZATION rather than by anyone touching the order:
 *     graded `SCR_COMPOUND_FORMULA_NOT_CODED`, ORGANIZATION_DATA,
 *     informational. Distinct from OUT_OF_NOMENCLATURE because "no
 *     update can ever resolve this" stopped being true the day local
 *     declaration shipped, and a reason that says so would lie.
 *
 * `IN_NOMENCLATURE` / `OUT_OF_NOMENCLATURE` are consulted only after
 * `describeDrug` returned `null` and only when `coverage` is
 * PROVISIONED (an unprovisioned source cannot resolve anything, so
 * the distinction adds no information). `LOCALLY_DECLARABLE` is
 * consulted whenever `describeDrug` returned `null`, REGARDLESS of
 * coverage: the org's own formulary is a body of knowledge
 * independent of any licensed release, and "code the formula" is the
 * true remediation whether or not a national database is wired. A
 * source with no basis for the judgement answers IN_NOMENCLATURE —
 * over-prompting is the conservative direction.
 */
export const DRUG_CODE_SCOPES = Object.freeze([
  "IN_NOMENCLATURE",
  "OUT_OF_NOMENCLATURE",
  "LOCALLY_DECLARABLE",
] as const);

export type DrugCodeScope = (typeof DRUG_CODE_SCOPES)[number];

/**
 * The identity of the body of knowledge a source answers from.
 *
 * Findings are persisted verbatim into append-only tables while the
 * reference data underneath them moves on every ingestion, so "why
 * did this not fire in March?" is answerable only if each screen
 * names the release it resolved against — the same treatment
 * `workflow_policy_id` + `workflow_policy_version` already give the
 * policy. The wiring layer stamps these two values onto every
 * persisted finding row.
 */
export interface DrugKnowledgeRelease {
  /** Stable source identifier, e.g. "RXNORM_PRESCRIBABLE". */
  readonly source: string;
  /** The release version as the publisher names it, e.g. "07072026". */
  readonly version: string;
}

/**
 * The identity of the org-declared compound formula VERSION a drug
 * code's answer was drawn from — the per-code counterpart of
 * `DrugKnowledgeRelease`, for the body of knowledge that has no
 * publisher because the org wrote it itself.
 *
 * A licensed release versions as one unit and is stamped once per
 * screen; formulas version independently per recipe, so their
 * attribution has to travel per drug code. The wiring layer stamps
 * these three values onto the persisted finding rows the formula
 * contributed to, which is what keeps "which recipe did March's
 * screen read?" answerable after the recipe is republished.
 */
export interface CompoundFormulaProvenance {
  readonly formulaId: string;
  readonly formulaCode: string;
  readonly formulaVersion: number;
}

/**
 * The seam. Implement this over a licensed clinical database, behind
 * an adapter, and the engine works unchanged.
 *
 * Implementer contract:
 *   - Pure and synchronous. No I/O, no clock, no throwing.
 *   - `coverage` is CONSTANT for the lifetime of the source. The
 *     engine reads it while grading and a source that changed its
 *     answer mid-screen would grade two lines of one order
 *     differently.
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
  readonly coverage: DrugKnowledgeCoverage;
  /**
   * The release this source answers from, or `null` for a source with
   * no release identity (the caller-seeded in-memory container, or an
   * unprovisioned deployment). Constant for the lifetime of the
   * source, for the same reason `coverage` is.
   */
  readonly release: DrugKnowledgeRelease | null;
  describeDrug(code: DrugCode): DrugKnowledge | null;
  describeAllergen(code: AllergenCode): AllergenKnowledge | null;
  /**
   * Consulted when `describeDrug(code)` returned `null`, to decide
   * how the resulting gap is graded: LOCALLY_DECLARABLE at any
   * coverage; the other two values only when `coverage` is
   * PROVISIONED. See `DRUG_CODE_SCOPES`. Pure, like every other
   * member.
   */
  drugCodeScope(code: DrugCode): DrugCodeScope;
  /**
   * The org-declared formula version the answer (or the consulted
   * non-answer) for `code` came from, or `null` for a code this
   * source resolves from published nomenclature — the common case,
   * and the only case for a source with no local-declaration
   * capability.
   *
   * Non-null does NOT imply `describeDrug` answered: a formula that
   * exists but has no coded rows is a consulted body of knowledge
   * that produced a gap, and the gap row deserves the attribution as
   * much as a finding would — "which uncoded recipe was on file?" is
   * exactly what its reader asks.
   */
  compoundFormulaProvenance(code: DrugCode): CompoundFormulaProvenance | null;
  findIngredientInteraction(a: IngredientCode, b: IngredientCode): InteractionFact | null;
}
