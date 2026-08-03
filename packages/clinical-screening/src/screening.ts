// Prospective clinical screening for the PV1 stage: the checks a
// pharmacist performs before verifying a prescription, computed so
// they arrive with the order instead of depending on the pharmacist
// remembering to look.
//
// TOTAL and PURE, in the same spirit as `@pharmax/controlled-substances`:
// no clock, no I/O, no database, no exceptions. Facts go in, a complete
// evaluation comes out. The same call is therefore usable from a
// command handler, from a UI affordance check, and from a replay over
// `command_log` — and it returns EVERY finding rather than the first,
// because a pharmacist who fixes one problem and immediately meets a
// second has been made to do the job twice.
//
// -------------------------------------------------------------------
// The alert-fatigue argument, which is the whole design
// -------------------------------------------------------------------
//
// Interruptive clinical alerts are override-rate machines. The
// published literature on computerised prescriber-order-entry and
// pharmacy DUR alerting is consistent and unflattering: override rates
// well above 90% are ordinary, and the mechanism is not carelessness —
// it is that a queue of alerts which are usually wrong trains a fast,
// accurate heuristic that the next one is wrong too. Once that
// heuristic is trained, the alert that mattered is dismissed by the
// same reflex as the ninety that did not, and the system has made the
// pharmacist LESS safe than no alerting at all while producing an
// audit trail that says otherwise.
//
// Five decisions follow from that, and each is enforced somewhere in
// this file rather than left to the caller:
//
//   1. HARD STOPS ARE ALMOST UNREACHABLE. Blocking requires maximum
//      severity AND certainty together (`dispositionFor`), which two
//      situations reach: a confirmed high-criticality immune-mediated
//      allergy to the exact ingredient dispensed, and an interaction
//      the knowledge source explicitly grades CONTRAINDICATED and
//      DEFINITE. Every finding the engine derives on its own —
//      cross-sensitivity, duplication, dose, gaps — is graded so that
//      it CANNOT block, because each has a legitimate clinical case
//      behind it that the pharmacist may know about and we cannot.
//   2. ACKNOWLEDGEMENTS CARRY FORWARD. A finding the pharmacist has
//      already dispositioned is downgraded to informational on later
//      screens (`acknowledgedFingerprints`). Re-asking about an
//      unchanged profile every month is how a queue of alerts becomes
//      background noise. Hard stops never downgrade.
//   3. INFERENCES ARE NOT DRESSED UP AS FACTS. Class-level matches
//      carry `POSSIBLE` certainty and a distinct finding code from
//      exact matches, so the console can present them differently and
//      reporting can measure them separately.
//   4. ONE PROBLEM, ONE FINDING. Same-ingredient duplication
//      suppresses the class-level duplication it necessarily implies;
//      identical findings from several profile rows merge into one
//      with the union of their triggers.
//   5. WHAT WE COULD NOT SCREEN IS ITSELF REPORTED. An unknown drug
//      produces a `SCREENING_GAP`, because otherwise "no findings"
//      reads as "clinically clear" when it means "never checked" —
//      and that is the single most dangerous sentence this engine
//      could say. The corollary is that gaps must be rare and
//      specific, so allergies that a drug knowledge base could never
//      answer (food, environmental) are excluded from screening
//      entirely rather than reported as gaps on every prescription.
//
// The vocabulary for allergy records follows HL7 FHIR R4
// `AllergyIntolerance` — `category`, `type`, `criticality`,
// `verificationStatus`. Those four public fields carry most of the
// discrimination this engine needs, and adopting them means an
// intake path that already speaks FHIR maps straight in.

import type {
  ScreeningCertainty,
  ScreeningFinding,
  ScreeningFindingCode,
  ScreeningFindingKind,
  ScreeningSeverity,
  ScreeningTrigger,
} from "./findings.js";
import {
  dispositionFor,
  fingerprintOf,
  isAtLeastAsSevere,
  leastSevere,
  severityRank,
} from "./findings.js";
import type {
  AllergenCode,
  DrugCode,
  DrugKnowledge,
  DrugKnowledgeSource,
} from "./knowledge-source.js";

// ---------------------------------------------------------------------------
// Request vocabulary
// ---------------------------------------------------------------------------

/**
 * A prescribed amount, as typed. `dosesPerDay` is 0 for a PRN
 * instruction with no defined schedule — daily-total checks are then
 * skipped rather than evaluated against a fictional zero.
 */
export interface DoseStatement {
  readonly amount: number;
  readonly unit: string;
  readonly dosesPerDay: number;
}

/**
 * A drug on the prescription being screened, or on the patient's
 * active profile.
 *
 * `recordId` is the caller's opaque handle — a prescription-line id.
 * The engine never interprets it and it is the ONLY identifier that
 * reaches a finding, which is what keeps findings free of PHI.
 */
export interface PrescribedDrug {
  readonly recordId: string;
  readonly drugCode: DrugCode;
  readonly dose: DoseStatement | null;
}

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

export interface RecordedAllergy {
  readonly recordId: string;
  /** The substance reacted to: an ingredient, or a class. */
  readonly substanceCode: AllergenCode;
  readonly category: AllergyCategory;
  readonly type: AllergyType;
  readonly criticality: AllergyCriticality;
  readonly verificationStatus: AllergyVerificationStatus;
}

/**
 * Pharmacy-configurable screening behaviour.
 *
 * Deliberately small. Every knob here is a way to see fewer findings,
 * and each one is a decision a pharmacy should have to make
 * explicitly — so there is no facility for suppressing an individual
 * finding code, which is how a screening engine quietly stops
 * screening.
 */
export interface ScreeningPolicy {
  /**
   * Findings below this grade are dropped before the result is built.
   *
   * The intended use is raising the floor to `MODERATE` to retire the
   * informational tier once a pharmacy decides it adds nothing.
   * Raising it further is legal and unwise: at `CONTRAINDICATED` the
   * engine reports only what it would block on, and the acknowledge
   * tier — the part that actually changes decisions — disappears.
   */
  readonly minimumReportedSeverity: ScreeningSeverity;
}

export const DEFAULT_SCREENING_POLICY: ScreeningPolicy = Object.freeze({
  minimumReportedSeverity: "MINOR",
});

export interface ScreeningRequest {
  /** The prescription line being screened. */
  readonly candidate: PrescribedDrug;
  /**
   * The patient's other active medications. If the candidate's own
   * line appears here (a refill re-screened against a profile that
   * already contains it), it is skipped by `recordId` — screening a
   * drug against itself would report every combination product as
   * duplicating itself.
   */
  readonly activeMedications: ReadonlyArray<PrescribedDrug>;
  readonly allergies: ReadonlyArray<RecordedAllergy>;
  readonly knowledge: DrugKnowledgeSource;
  /**
   * Fingerprints a pharmacist has already dispositioned for this
   * patient. Passed in rather than looked up, to keep this function
   * pure; the caller reads them from the acknowledgement records it
   * wrote on previous screens.
   */
  readonly acknowledgedFingerprints: ReadonlySet<string>;
  readonly policy: ScreeningPolicy;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export const SCREENING_OUTCOMES = Object.freeze(["CLEAR", "ADVISORY", "BLOCKED"] as const);

export type ScreeningOutcome = (typeof SCREENING_OUTCOMES)[number];

/**
 * Three outcomes rather than a boolean, because the middle one is the
 * common case and collapsing it into either neighbour loses the
 * product. `CLEAR` carries an empty tuple rather than omitting the
 * field so a consumer can read `.findings` without narrowing first.
 */
export type ScreeningEvaluation =
  | { readonly outcome: "CLEAR"; readonly findings: readonly [] }
  | { readonly outcome: "ADVISORY"; readonly findings: ReadonlyArray<ScreeningFinding> }
  | { readonly outcome: "BLOCKED"; readonly findings: ReadonlyArray<ScreeningFinding> };

/** Findings that block. Non-empty exactly when the outcome is BLOCKED. */
export function hardStopFindings(evaluation: ScreeningEvaluation): ReadonlyArray<ScreeningFinding> {
  const findings: ReadonlyArray<ScreeningFinding> = evaluation.findings;
  return findings.filter((f) => f.disposition === "HARD_STOP");
}

/**
 * Findings the pharmacist must disposition before PV1 can pass. The
 * wiring layer records an acknowledgement per fingerprint returned
 * here.
 */
export function findingsRequiringAcknowledgement(
  evaluation: ScreeningEvaluation
): ReadonlyArray<ScreeningFinding> {
  const findings: ReadonlyArray<ScreeningFinding> = evaluation.findings;
  return findings.filter((f) => f.disposition === "REQUIRES_ACKNOWLEDGEMENT");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Screen one prescription line against the patient's profile.
 *
 * Runs every check that the available knowledge supports, reports what
 * it could not run, and never short-circuits.
 */
export function screenPrescription(request: ScreeningRequest): ScreeningEvaluation {
  const raw: ScreeningFinding[] = [];
  const candidateKnowledge = request.knowledge.describeDrug(request.candidate.drugCode);

  if (candidateKnowledge === null) {
    // Nothing downstream can run without the candidate's ingredients,
    // so this is the whole screen: one unmistakable gap rather than a
    // silent pass.
    raw.push(knowledgeGapFinding("CANDIDATE_DRUG", request.candidate));
  } else {
    collectAllergyFindings(request, candidateKnowledge, raw);
    collectProfileFindings(request, candidateKnowledge, raw);
    collectDoseFindings(request, candidateKnowledge, raw);
  }

  const reportable = raw.filter((f) =>
    isAtLeastAsSevere(f.severity, request.policy.minimumReportedSeverity)
  );
  const merged = mergeByFingerprint(reportable);
  const settled = merged.map((f) => applyPriorAcknowledgement(f, request.acknowledgedFingerprints));
  const findings = [...settled].sort(compareFindings);

  if (findings.length === 0) {
    return { outcome: "CLEAR", findings: [] };
  }
  if (findings.some((f) => f.disposition === "HARD_STOP")) {
    return { outcome: "BLOCKED", findings };
  }
  return { outcome: "ADVISORY", findings };
}

// ---------------------------------------------------------------------------
// Allergy screening
// ---------------------------------------------------------------------------

function collectAllergyFindings(
  request: ScreeningRequest,
  candidateKnowledge: DrugKnowledge,
  out: ScreeningFinding[]
): void {
  for (const allergy of request.allergies) {
    if (!isScreenableCategory(allergy.category)) continue;
    if (!isScreenableVerificationStatus(allergy.verificationStatus)) continue;

    const certainty = allergyCertainty(allergy);

    if (candidateKnowledge.ingredientCodes.includes(allergy.substanceCode)) {
      out.push(
        finding({
          code: "SCR_DRUG_ALLERGY_DIRECT",
          kind: "DRUG_ALLERGY",
          severity: directAllergySeverity(allergy),
          certainty,
          reason: `The patient has a recorded ${allergy.type.toLowerCase()} to ${allergy.substanceCode}, which is an active ingredient of the prescribed drug.`,
          triggers: [
            trigger("RECORDED_ALLERGY", allergy.recordId, allergy.substanceCode),
            trigger("CANDIDATE_DRUG", request.candidate.recordId, allergy.substanceCode),
          ],
          citation: null,
        })
      );
      // An exact match makes the class-level inference redundant: same
      // substance, same conversation with the prescriber.
      continue;
    }

    const allergen = request.knowledge.describeAllergen(allergy.substanceCode);
    if (allergen === null) {
      // No cross-sensitivity data for this substance. Not reported as
      // a gap: the exact-ingredient comparison above needed no
      // knowledge lookup and has already run, and a knowledge base is
      // never going to hold every substance a patient has reacted to.
      // A gap on each of those would fire on every prescription
      // forever, which is the failure mode this engine is built to
      // avoid.
      continue;
    }

    for (const classCode of sharedCodes(
      allergen.crossSensitivityClassCodes,
      candidateKnowledge.crossSensitivityClassCodes
    )) {
      out.push(
        finding({
          code: "SCR_DRUG_ALLERGY_CROSS_SENSITIVITY",
          kind: "DRUG_ALLERGY",
          severity: crossSensitivitySeverity(allergy),
          // Class membership is an inference about this patient, never
          // an observation of them — so it cannot reach a hard stop
          // however critical the underlying reaction was.
          certainty: "POSSIBLE",
          reason: `The prescribed drug shares cross-sensitivity class ${classCode} with ${allergy.substanceCode}, to which the patient has a recorded ${allergy.type.toLowerCase()}.`,
          triggers: [
            trigger("RECORDED_ALLERGY", allergy.recordId, allergy.substanceCode),
            trigger("CANDIDATE_DRUG", request.candidate.recordId, classCode),
          ],
          citation: null,
        })
      );
    }
  }
}

/**
 * Drug knowledge answers drug questions. Food and environmental
 * allergies are clinically real but unanswerable here, and screening
 * them would produce a permanent gap finding on every prescription for
 * any patient with a shellfish allergy on file. Excluded at the door.
 */
function isScreenableCategory(category: AllergyCategory): boolean {
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
function isScreenableVerificationStatus(status: AllergyVerificationStatus): boolean {
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
 * Only a CONFIRMED record is a fact about this patient. An unconfirmed
 * one is usually a self-report taken at intake — often accurate, often
 * a childhood rash nobody has revisited. It is enough to interrupt for
 * and not enough to refuse on, which is exactly the gap between
 * `DEFINITE` and `PROBABLE`.
 */
function allergyCertainty(allergy: RecordedAllergy): ScreeningCertainty {
  return allergy.verificationStatus === "CONFIRMED" ? "DEFINITE" : "PROBABLE";
}

function severityFromCriticality(criticality: AllergyCriticality): ScreeningSeverity {
  switch (criticality) {
    case "HIGH":
      return "CONTRAINDICATED";
    case "LOW":
      return "MAJOR";
    case "UNABLE_TO_ASSESS":
      // Ungraded, so graded conservatively — but never to the tier
      // that can block, because "nobody assessed this" is not a basis
      // for refusing to dispense.
      return "MAJOR";
    default: {
      const exhaustive: never = criticality;
      return exhaustive;
    }
  }
}

function directAllergySeverity(allergy: RecordedAllergy): ScreeningSeverity {
  const graded = severityFromCriticality(allergy.criticality);
  switch (allergy.type) {
    case "ALLERGY":
      return graded;
    case "INTOLERANCE":
      // Capped: an intolerance is a tolerability problem, not an
      // immune one. Left ungraded it would inherit HIGH criticality
      // and hard-stop a dispense over documented nausea.
      return leastSevere(graded, "MODERATE");
    default: {
      const exhaustive: never = allergy.type;
      return exhaustive;
    }
  }
}

/** One grade below the direct match: same reaction, weaker link. */
function crossSensitivitySeverity(allergy: RecordedAllergy): ScreeningSeverity {
  return leastSevere(directAllergySeverity(allergy), "MAJOR");
}

// ---------------------------------------------------------------------------
// Interaction and duplication screening
// ---------------------------------------------------------------------------

function collectProfileFindings(
  request: ScreeningRequest,
  candidateKnowledge: DrugKnowledge,
  out: ScreeningFinding[]
): void {
  for (const med of request.activeMedications) {
    if (med.recordId === request.candidate.recordId) continue;

    const medKnowledge = request.knowledge.describeDrug(med.drugCode);
    if (medKnowledge === null) {
      // Reported only because the candidate IS known: this pair could
      // otherwise have been screened, so the gap is specific and
      // actionable. When the candidate is unknown no pair is
      // screenable and the candidate's own gap says everything.
      out.push(knowledgeGapFinding("PROFILE_MEDICATION", med));
      continue;
    }

    collectInteractions(request, candidateKnowledge, med, medKnowledge, out);
    collectDuplication(request, candidateKnowledge, med, medKnowledge, out);
  }
}

function collectInteractions(
  request: ScreeningRequest,
  candidateKnowledge: DrugKnowledge,
  med: PrescribedDrug,
  medKnowledge: DrugKnowledge,
  out: ScreeningFinding[]
): void {
  for (const candidateIngredient of candidateKnowledge.ingredientCodes) {
    for (const profileIngredient of medKnowledge.ingredientCodes) {
      // The same ingredient on both sides is a duplication, and is
      // reported as one. Asking the knowledge source whether a
      // substance interacts with itself is a category error.
      if (candidateIngredient === profileIngredient) continue;

      const fact = request.knowledge.findIngredientInteraction(
        candidateIngredient,
        profileIngredient
      );
      if (fact === null) continue;

      out.push(
        finding({
          code: "SCR_DRUG_INTERACTION",
          kind: "DRUG_DRUG_INTERACTION",
          severity: fact.severity,
          certainty: fact.certainty,
          reason: `Ingredient ${candidateIngredient} on the prescribed drug interacts with ingredient ${profileIngredient} on the patient's active profile.`,
          triggers: [
            trigger("CANDIDATE_DRUG", request.candidate.recordId, candidateIngredient),
            trigger("PROFILE_MEDICATION", med.recordId, profileIngredient),
          ],
          citation: fact.citation,
        })
      );
    }
  }
}

function collectDuplication(
  request: ScreeningRequest,
  candidateKnowledge: DrugKnowledge,
  med: PrescribedDrug,
  medKnowledge: DrugKnowledge,
  out: ScreeningFinding[]
): void {
  const sharedIngredients = sharedCodes(
    candidateKnowledge.ingredientCodes,
    medKnowledge.ingredientCodes
  );

  for (const ingredient of sharedIngredients) {
    out.push(
      finding({
        code: "SCR_DUPLICATE_INGREDIENT",
        kind: "THERAPEUTIC_DUPLICATION",
        // Serious, and still not a hard stop: overlapping the same
        // ingredient is standard practice during a cross-taper, a dose
        // titration, or a scheduled-plus-PRN regimen. The pharmacist
        // can see the intent on the sig; the engine cannot.
        severity: "MAJOR",
        certainty: "DEFINITE",
        reason: `Ingredient ${ingredient} is already active on the patient's profile.`,
        triggers: [
          trigger("CANDIDATE_DRUG", request.candidate.recordId, ingredient),
          trigger("PROFILE_MEDICATION", med.recordId, ingredient),
        ],
        citation: null,
      })
    );
  }

  // A shared ingredient already implies a shared class. Reporting both
  // describes one clinical situation twice and trains the pharmacist
  // to skim.
  if (sharedIngredients.length > 0) return;

  for (const classCode of sharedCodes(
    candidateKnowledge.therapeuticClassCodes,
    medKnowledge.therapeuticClassCodes
  )) {
    out.push(
      finding({
        code: "SCR_DUPLICATE_THERAPEUTIC_CLASS",
        kind: "THERAPEUTIC_DUPLICATION",
        severity: "MODERATE",
        // Two members of one class is often the treatment, not a
        // mistake — combination antihypertensive and antiretroviral
        // regimens are built that way on purpose.
        certainty: "POSSIBLE",
        reason: `The prescribed drug and an active profile medication both belong to therapeutic class ${classCode}.`,
        triggers: [
          trigger("CANDIDATE_DRUG", request.candidate.recordId, classCode),
          trigger("PROFILE_MEDICATION", med.recordId, classCode),
        ],
        citation: null,
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Dose-range screening
// ---------------------------------------------------------------------------

/**
 * Relative tolerance for dose comparisons.
 *
 * A daily total is a product of two caller-supplied decimals, so an
 * exactly-at-the-limit regimen lands a few ulps above it — 0.1 mg
 * three times a day is not 0.3 in binary floating point. Comparing
 * strictly would fire a MAJOR finding on a correct prescription, which
 * is the most expensive kind of false positive there is.
 */
const DOSE_COMPARISON_RELATIVE_TOLERANCE = 1e-9;

function exceeds(value: number, limit: number): boolean {
  return value - limit > Math.abs(limit) * DOSE_COMPARISON_RELATIVE_TOLERANCE;
}

function fallsShortOf(value: number, limit: number): boolean {
  return limit - value > Math.abs(limit) * DOSE_COMPARISON_RELATIVE_TOLERANCE;
}

function collectDoseFindings(
  request: ScreeningRequest,
  candidateKnowledge: DrugKnowledge,
  out: ScreeningFinding[]
): void {
  const range = candidateKnowledge.doseRange;
  const dose = request.candidate.dose;
  if (range === null || dose === null) return;

  if (range.unit !== dose.unit) {
    // Reported, not converted. A wrong mg/mcg factor buried in a
    // safety check is worse than no check, and the pharmacist can
    // reconcile the units in seconds.
    out.push(
      finding({
        code: "SCR_DOSE_UNIT_NOT_COMPARABLE",
        kind: "SCREENING_GAP",
        severity: "MODERATE",
        certainty: "DEFINITE",
        reason: `The prescribed dose is expressed in ${dose.unit} but the known dosing range for ${request.candidate.drugCode} is expressed in ${range.unit}; no conversion was attempted and the dose was not screened.`,
        triggers: [
          trigger("CANDIDATE_DRUG", request.candidate.recordId, request.candidate.drugCode),
        ],
        citation: range.citation,
      })
    );
    return;
  }

  if (range.maxSingleDose !== null && exceeds(dose.amount, range.maxSingleDose)) {
    out.push(
      finding({
        code: "SCR_DOSE_ABOVE_SINGLE_MAXIMUM",
        kind: "DOSE_RANGE",
        // Never CONTRAINDICATED, at any excess. A dosing range is a
        // population statement; oncology, palliative care and opioid
        // tolerance all exceed it as a matter of correct practice.
        severity: "MAJOR",
        certainty: "DEFINITE",
        reason: `The prescribed single dose of ${dose.amount} ${dose.unit} is above the known maximum of ${range.maxSingleDose} ${range.unit}.`,
        triggers: [
          trigger("CANDIDATE_DRUG", request.candidate.recordId, request.candidate.drugCode),
        ],
        citation: range.citation,
      })
    );
  }

  // Without a schedule there is no daily total to test. A PRN sig is
  // the usual reason, and inventing one from a zero frequency would
  // report every PRN as sub-therapeutic.
  if (dose.dosesPerDay <= 0) return;

  const dailyTotal = dose.amount * dose.dosesPerDay;

  if (range.maxDailyDose !== null && exceeds(dailyTotal, range.maxDailyDose)) {
    out.push(
      finding({
        code: "SCR_DOSE_ABOVE_DAILY_MAXIMUM",
        kind: "DOSE_RANGE",
        severity: "MAJOR",
        certainty: "DEFINITE",
        reason: `The prescribed daily total of ${dailyTotal} ${dose.unit} is above the known maximum of ${range.maxDailyDose} ${range.unit}.`,
        triggers: [
          trigger("CANDIDATE_DRUG", request.candidate.recordId, request.candidate.drugCode),
        ],
        citation: range.citation,
      })
    );
  }

  if (range.minDailyDose !== null && fallsShortOf(dailyTotal, range.minDailyDose)) {
    out.push(
      finding({
        code: "SCR_DOSE_BELOW_DAILY_MINIMUM",
        kind: "DOSE_RANGE",
        // MINOR, therefore informational. Starting below the usual
        // range is deliberate often enough — titration, renal or
        // hepatic adjustment, paediatric dosing — that interrupting
        // for it would cost more attention than it saves.
        severity: "MINOR",
        certainty: "DEFINITE",
        reason: `The prescribed daily total of ${dailyTotal} ${dose.unit} is below the known minimum of ${range.minDailyDose} ${range.unit}.`,
        triggers: [
          trigger("CANDIDATE_DRUG", request.candidate.recordId, request.candidate.drugCode),
        ],
        citation: range.citation,
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Construction, merging, ordering
// ---------------------------------------------------------------------------

function trigger(
  source: ScreeningTrigger["source"],
  recordId: string,
  code: string
): ScreeningTrigger {
  return { source, recordId, code };
}

interface FindingDraft {
  readonly code: ScreeningFindingCode;
  readonly kind: ScreeningFindingKind;
  readonly severity: ScreeningSeverity;
  readonly certainty: ScreeningCertainty;
  readonly reason: string;
  readonly triggers: ReadonlyArray<ScreeningTrigger>;
  readonly citation: string | null;
}

/**
 * Disposition and fingerprint are derived here and nowhere else, so no
 * call site can mint a finding that blocks without going through
 * `dispositionFor`.
 */
function finding(draft: FindingDraft): ScreeningFinding {
  return {
    ...draft,
    disposition: dispositionFor(draft.severity, draft.certainty),
    fingerprint: fingerprintOf(draft.code, draft.triggers),
  };
}

function knowledgeGapFinding(
  source: "CANDIDATE_DRUG" | "PROFILE_MEDICATION",
  drug: PrescribedDrug
): ScreeningFinding {
  const scope =
    source === "CANDIDATE_DRUG"
      ? "no screening could be performed for this prescription"
      : "this profile medication was excluded from interaction and duplication screening";
  return finding({
    code: "SCR_KNOWLEDGE_UNAVAILABLE",
    kind: "SCREENING_GAP",
    // High enough to demand acknowledgement, never high enough to
    // block: refusing to dispense because our reference data is
    // incomplete would make a gap in our knowledge the patient's
    // problem.
    severity: "MODERATE",
    certainty: "DEFINITE",
    reason: `No drug knowledge is available for ${drug.drugCode}; ${scope}.`,
    triggers: [trigger(source, drug.recordId, drug.drugCode)],
    citation: null,
  });
}

/**
 * Collapse findings that describe the same clinical situation.
 *
 * Triggers are UNIONED rather than discarded: two profile rows sharing
 * an ingredient produce one finding, and a reviewer must still be able
 * to reach both rows from it. The surviving severity is the highest
 * seen, so a merge can never soften a finding.
 */
function mergeByFingerprint(findings: ReadonlyArray<ScreeningFinding>): ScreeningFinding[] {
  const byFingerprint = new Map<string, ScreeningFinding>();

  for (const candidate of findings) {
    const existing = byFingerprint.get(candidate.fingerprint);
    if (existing === undefined) {
      byFingerprint.set(candidate.fingerprint, candidate);
      continue;
    }

    const dominant =
      severityRank(candidate.severity) > severityRank(existing.severity) ? candidate : existing;
    byFingerprint.set(candidate.fingerprint, {
      ...dominant,
      triggers: mergeTriggers(existing.triggers, candidate.triggers),
    });
  }

  return [...byFingerprint.values()];
}

function mergeTriggers(
  a: ReadonlyArray<ScreeningTrigger>,
  b: ReadonlyArray<ScreeningTrigger>
): ReadonlyArray<ScreeningTrigger> {
  const seen = new Map<string, ScreeningTrigger>();
  for (const t of [...a, ...b]) {
    seen.set(`${t.source}\u0000${t.recordId}\u0000${t.code}`, t);
  }
  return [...seen.values()];
}

/**
 * Downgrade a finding the pharmacist has already dispositioned.
 *
 * A hard stop is never downgraded — an unoverridable finding that a
 * prior acknowledgement could switch off would not be unoverridable,
 * it would just be slower.
 */
function applyPriorAcknowledgement(
  candidate: ScreeningFinding,
  acknowledged: ReadonlySet<string>
): ScreeningFinding {
  if (candidate.disposition !== "REQUIRES_ACKNOWLEDGEMENT") return candidate;
  if (!acknowledged.has(candidate.fingerprint)) return candidate;
  return { ...candidate, disposition: "INFORMATIONAL" };
}

/**
 * Most severe first, then a stable tiebreak on code and fingerprint.
 * Deterministic ordering matters twice over: the console shows the
 * finding that matters at the top, and two replays of the same command
 * produce byte-identical event payloads.
 */
function compareFindings(a: ScreeningFinding, b: ScreeningFinding): number {
  const bySeverity = severityRank(b.severity) - severityRank(a.severity);
  if (bySeverity !== 0) return bySeverity;
  const byCode = a.code.localeCompare(b.code);
  if (byCode !== 0) return byCode;
  return a.fingerprint.localeCompare(b.fingerprint);
}

/** Codes present in both lists, deduplicated and ordered stably. */
function sharedCodes(a: ReadonlyArray<string>, b: ReadonlyArray<string>): ReadonlyArray<string> {
  const inB = new Set(b);
  return [...new Set(a.filter((code) => inB.has(code)))].sort((x, y) => x.localeCompare(y));
}
