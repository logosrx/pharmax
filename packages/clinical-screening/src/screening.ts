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
//   5. WHAT WE COULD NOT SCREEN IS ITSELF REPORTED, AND THAT IS A
//      GUARANTEE THIS FILE ENFORCES RATHER THAN A HABIT IT ASKS FOR.
//      Every axis in `CLINICAL_SCREENING_AXES` either runs or
//      produces a `SCREENING_GAP` naming itself; there is no third
//      outcome, because a caller cannot build a `ScreeningRequest`
//      without declaring each axis available or unavailable, and an
//      unavailable declaration is what emits the gap. Two situations
//      reach it: a drug the knowledge source does not recognise
//      (`SCR_KNOWLEDGE_UNAVAILABLE`), and an input the caller could
//      not supply at all (`SCR_*_INPUT_UNAVAILABLE`). Without both,
//      "no findings" is ambiguous between "screened and clear" and
//      "never checked", and a pharmacist reads the safer meaning into
//      the more dangerous state.
//
//      The corollary is that gaps must be rare and SPECIFIC, so they
//      are bounded on three sides. Allergies a drug knowledge base
//      could never answer (food, environmental) are excluded from
//      screening rather than gapped on every prescription;
//      unavailability is DECLARED, never inferred from an empty
//      array, so a patient with genuinely no recorded allergies
//      screens clear on that axis instead of meeting a permanent
//      alert that teaches them to dismiss it; and a gap NOBODY IN THE
//      PHARMACY CAN CLOSE is recorded without interrupting, because a
//      gap that fires on every order forever is the alert-fatigue
//      machine above wearing this feature's clothes. That last one is
//      the `ScreeningGapRemediation` split — see
//      `screeningGapSeverity`, which is where the reasoning lives.
//      RECORDED IS NOT THE SAME AS INTERRUPTIVE: every gap is still
//      emitted, persisted and reportable whichever way it is graded.
//
//      And a gap is exempt from `minimumReportedSeverity` at every
//      setting, so no tenant configuration can take a screen back to
//      being indistinguishable from one that ran clean. See
//      `isReportable`. The two properties are independent and the
//      engine holds both: never nag, always record.
//
// The vocabulary for allergy records follows HL7 FHIR R4
// `AllergyIntolerance` — `category`, `type`, `criticality`,
// `verificationStatus`. Those four public fields carry most of the
// discrimination this engine needs, and adopting them means an
// intake path that already speaks FHIR maps straight in.

import type {
  AllergyCategory,
  AllergyCriticality,
  AllergyType,
  AllergyVerificationStatus,
} from "./allergy.js";
import { isScreenableAllergyCategory, isScreenableAllergyVerificationStatus } from "./allergy.js";
import type {
  ScreeningCertainty,
  ScreeningFinding,
  ScreeningFindingCode,
  ScreeningFindingKind,
  ScreeningGapRemediation,
  ScreeningInputAvailability,
  ScreeningInputAxis,
  ScreeningSeverity,
  ScreeningTrigger,
} from "./findings.js";
import {
  dispositionFor,
  fingerprintOf,
  gapRemediationForAvailability,
  isAtLeastAsSevere,
  leastSevere,
  screeningGapSeverity,
  severityRank,
  CLINICAL_SCREENING_AXES,
  INPUT_UNAVAILABLE_CODE_FOR_AXIS,
} from "./findings.js";
import type {
  AllergenCode,
  DrugCode,
  DrugKnowledge,
  DrugKnowledgeCoverage,
  DrugKnowledgeSource,
} from "./knowledge-source.js";
import { gapRemediationForCoverage } from "./knowledge-source.js";

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
  /**
   * `null` means this prescription carries no dose to compare — not
   * that the caller could not work one out. A caller that cannot
   * parse a dose declares DOSE_RANGE unavailable on the request
   * instead, which is reported as a gap; overloading `null` with both
   * meanings is what let dose screening silently never run.
   */
  readonly dose: DoseStatement | null;
}

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
   * CLINICAL findings below this grade are dropped before the result is
   * built. `SCREENING_GAP` findings are exempt at every setting — see
   * `isReportable`, which is where that exemption and its reasoning
   * live.
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
   * Which axes the caller was able to supply facts for.
   *
   * REQUIRED AND EXHAUSTIVE, for the same reason `qualifiers` is
   * required on a finding draft: the default answer is the unsafe
   * one. An optional field, or a list of unavailable axes, would let
   * a fifth axis land with every existing call site silently
   * asserting it screens something it has no data for. Spelled out as
   * a total map, the compiler stops the build at each call site
   * instead.
   *
   * `UNAVAILABLE` means "I cannot answer this question", not "the
   * answer is empty" — see `ScreeningInputAvailability`. Declaring an
   * axis unavailable makes the engine skip it and report a gap; the
   * inputs for it, if any were passed, are ignored, because a caller
   * that has data has no reason to say it does not.
   */
  readonly inputAvailability: Readonly<Record<ScreeningInputAxis, ScreeningInputAvailability>>;
  /**
   * The patient's other active medications. If the candidate's own
   * line appears here (a refill re-screened against a profile that
   * already contains it), it is skipped by `recordId` — screening a
   * drug against itself would report every combination product as
   * duplicating itself.
   *
   * Feeds two axes, DRUG_DRUG_INTERACTION and
   * THERAPEUTIC_DUPLICATION, which are declared independently: a
   * caller can hold a medication list good enough to detect a
   * duplicate ingredient and still lack whatever an interaction check
   * needs.
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

  // Unsupplied inputs first, and unconditionally — including when the
  // candidate drug itself is unknown.
  //
  // The temptation is to suppress these when nothing could be
  // screened anyway, since "no drug knowledge for this drug" already
  // says the screen did not run. Resist it: the two say different
  // things to different people. An unknown drug is one row missing
  // from a licensed database and it resolves when that vendor ships
  // an update; an unsupplied axis is a capability this platform does
  // not have, and it resolves when someone builds it. Folding the
  // second into the first lets a permanent product gap hide behind a
  // transient data gap — and it would hide it precisely while the
  // knowledge source is empty, which is exactly when nobody would
  // notice.
  //
  // The cost is honest and temporary: a deployment missing both sees
  // several "could not check" findings per order, and each one is a
  // true statement that a pharmacist is right to have to acknowledge.
  // They disappear one at a time as the inputs land, without anyone
  // editing this file.
  collectInputUnavailabilityFindings(request, raw);

  const candidateKnowledge = request.knowledge.describeDrug(request.candidate.drugCode);

  if (candidateKnowledge === null) {
    // Nothing downstream can run without the candidate's ingredients,
    // so this is the rest of the screen: one unmistakable gap rather
    // than a silent pass.
    raw.push(knowledgeGapFinding("CANDIDATE_DRUG", request.candidate, request.knowledge.coverage));
  } else {
    // Each collector returns immediately when its own axis was
    // declared unavailable — one rule, applied in one place per axis,
    // rather than a gate here that a new collector could be added
    // without.
    collectAllergyFindings(request, candidateKnowledge, raw);
    collectProfileFindings(request, candidateKnowledge, raw);
    collectDoseFindings(request, candidateKnowledge, raw);
  }

  const reportable = raw.filter((f) => isReportable(f, request.policy.minimumReportedSeverity));
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

/**
 * Whether a finding survives the pharmacy's reporting floor.
 *
 * A `SCREENING_GAP` IS EXEMPT AT EVERY SETTING, and the reason is that
 * the floor and the gap answer different questions.
 * `minimumReportedSeverity` is a clinical noise floor: it exists so a
 * pharmacy can stop being told about findings too mild to change a
 * decision. A gap is not a finding about the prescription at all — see
 * `SCREENING_FINDING_KINDS`, where the kind is defined as "a report
 * that some part of the screen could NOT be performed". It answers
 * "did verification happen?", and there is no severity at which the
 * answer to that stops mattering.
 *
 * WHAT SUBJECTING GAPS TO THE FLOOR ACTUALLY DID. Filter them out and
 * an order carries zero gap rows — which is byte-for-byte what an
 * order that was fully screened and came back clean looks like. That
 * is precisely the ambiguity this whole finding kind was introduced to
 * destroy, reintroduced by the floor at the far end of the pipeline.
 * An auditor asking "was this order screened for allergies?" would
 * find no row and have to infer the answer from the tenant's policy
 * configuration at the time. Reconstructible is not recorded, and an
 * unscreened order that reads as fully screened is a compliance claim
 * the system did not earn.
 *
 * IT ALSO MADE A SAFETY PROPERTY TENANT-CONFIGURABLE, which is the
 * part that settles it. Whether the record distinguishes "screened" from
 * "never screened" must not depend on a customer's setting.
 *
 * WHY THE WHOLE KIND AND NOT JUST THE SYSTEMIC ONES. It is tempting to
 * exempt only `PLATFORM_CAPABILITY` gaps, since those are the ones
 * nobody can close. Three reasons not to:
 *
 *   - The invariant is "no screen may read as clear when it did not
 *     run", and ANY suppressed gap breaks it. A per-patient allergy gap
 *     dropped by the floor leaves exactly the same zero-row order.
 *   - It would invert the value ordering. The per-subject gap is the
 *     MORE actionable signal — somebody can go and obtain the missing
 *     fact — so exempting only the systemic one would leave the more
 *     valuable half suppressible by configuration.
 *   - Severity on a gap is instrumental, not clinical: it encodes
 *     whether to interrupt (see `screeningGapSeverity`). Filtering an
 *     instrumental value through a clinical floor is a category error
 *     whichever remediation it carries.
 *
 * This is INDEPENDENT of the interruption question. Gaps are always
 * recorded; whether one also demands an acknowledgement is decided by
 * `screeningGapSeverity` and nothing here. Never nag, always record.
 */
function isReportable(finding: ScreeningFinding, floor: ScreeningSeverity): boolean {
  if (finding.kind === "SCREENING_GAP") return true;
  return isAtLeastAsSevere(finding.severity, floor);
}

// ---------------------------------------------------------------------------
// Unsupplied inputs
// ---------------------------------------------------------------------------

function isAvailable(request: ScreeningRequest, axis: ScreeningInputAxis): boolean {
  return request.inputAvailability[axis] === "AVAILABLE";
}

/**
 * One gap per axis the caller declared it could not supply, graded by
 * WHO CAN CLOSE IT.
 *
 * Iterates `CLINICAL_SCREENING_AXES` rather than naming the four
 * axes, so this is the half of the guarantee that self-maintains: a
 * fifth finding kind becomes a fifth axis, the compiler forces a code
 * for it and a declaration at every call site, and this loop emits
 * its gap without being told.
 *
 * The gap is ALWAYS emitted, whichever way it is graded. "We could
 * not screen for allergies" is a compliance-relevant fact about a
 * dispense and it belongs in the record either way; what the grading
 * decides is only whether a pharmacist is interrupted for something
 * they cannot act on. See `screeningGapSeverity`.
 */
function collectInputUnavailabilityFindings(
  request: ScreeningRequest,
  out: ScreeningFinding[]
): void {
  for (const axis of CLINICAL_SCREENING_AXES) {
    const availability = request.inputAvailability[axis];
    if (availability === "AVAILABLE") continue;

    const remediation = gapRemediationForAvailability(availability);
    out.push(
      finding({
        code: INPUT_UNAVAILABLE_CODE_FOR_AXIS[axis],
        kind: "SCREENING_GAP",
        // Never high enough to block, at either grade. Refusing to
        // dispense because our platform cannot hold an allergy list
        // would make our missing capability the patient's problem.
        severity: screeningGapSeverity(remediation),
        certainty: "DEFINITE",
        reason: `No ${axis} input was available to this screen; that check was not performed. ${REMEDIATION_REASON[remediation]}`,
        // The axis is the trigger code — see `ScreeningTrigger.code`.
        // It keeps the fingerprint identical across drugs and lines,
        // so a pharmacist acknowledges "nobody recorded allergies for
        // this patient" once for the order rather than once per
        // prescription.
        triggers: [trigger("CANDIDATE_DRUG", request.candidate.recordId, axis)],
        // The remediation is interpolated into `reason` and is not a
        // trigger code, so `fingerprintOf` requires it here. Severity
        // already separates the two grades, but relying on that would
        // leave the identity depending on a coincidence of the
        // grading table rather than on what the finding says.
        qualifiers: [`remediation=${remediation}`],
        citation: null,
      })
    );
  }
}

/**
 * The sentence that tells a reader whose problem the gap is. Templated
 * from the remediation rather than free text, so it stays PHI-free by
 * construction like every other `reason` in this package.
 */
const REMEDIATION_REASON: Readonly<Record<ScreeningGapRemediation, string>> = Object.freeze({
  SUBJECT_DATA:
    "The platform supports this input but none was recorded for this subject; it can be obtained and the screen re-run.",
  PLATFORM_CAPABILITY:
    "This platform has no capability to supply that input for any subject, so no screen can perform this check until the capability is built.",
});

// ---------------------------------------------------------------------------
// Allergy screening
// ---------------------------------------------------------------------------

function collectAllergyFindings(
  request: ScreeningRequest,
  candidateKnowledge: DrugKnowledge,
  out: ScreeningFinding[]
): void {
  // The caller cannot tell us about this patient's allergies, so
  // `request.allergies` says nothing and iterating it would report a
  // clean allergy screen that never happened. The gap is already out.
  if (!isAvailable(request, "DRUG_ALLERGY")) return;

  for (const allergy of request.allergies) {
    // Defence in depth. A caller is expected to have filtered these
    // out already (see `isScreenableAllergy`), but the engine cannot
    // rely on that and the cost of checking twice is nil. What it
    // cannot re-check is `clinicalStatus`, which is not on
    // `RecordedAllergy` at all — that one is the caller's to enforce.
    if (!isScreenableAllergyCategory(allergy.category)) continue;
    if (!isScreenableAllergyVerificationStatus(allergy.verificationStatus)) continue;

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
          // The record being reclassified between an allergy and an
          // intolerance changes both the wording and the grading, so
          // it has to change the identity too.
          qualifiers: [`type=${allergy.type}`],
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
          qualifiers: [`type=${allergy.type}`],
          citation: null,
        })
      );
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
  const screensInteractions = isAvailable(request, "DRUG_DRUG_INTERACTION");
  const screensDuplication = isAvailable(request, "THERAPEUTIC_DUPLICATION");
  // Neither axis is being screened, so the profile is not being read
  // at all. Reporting an unscreenable profile ENTRY here would claim
  // we got as far as looking at it; the two axis gaps already say we
  // did not.
  if (!screensInteractions && !screensDuplication) return;

  for (const med of request.activeMedications) {
    if (med.recordId === request.candidate.recordId) continue;

    const medKnowledge = request.knowledge.describeDrug(med.drugCode);
    if (medKnowledge === null) {
      // Reported only because the candidate IS known: this pair could
      // otherwise have been screened, so the gap is specific and
      // actionable. When the candidate is unknown no pair is
      // screenable and the candidate's own gap says everything.
      out.push(knowledgeGapFinding("PROFILE_MEDICATION", med, request.knowledge.coverage));
      continue;
    }

    if (screensInteractions) {
      collectInteractions(request, candidateKnowledge, med, medKnowledge, out);
    }
    if (screensDuplication) {
      collectDuplication(request, candidateKnowledge, med, medKnowledge, out);
    }
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
          // Both ingredients are already trigger codes. The grading is
          // the source's and is carried by the fingerprint directly,
          // so an upgraded interaction re-prompts on its own.
          qualifiers: [],
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
        qualifiers: [],
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
        qualifiers: [],
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
  if (!isAvailable(request, "DOSE_RANGE")) return;

  const range = candidateKnowledge.doseRange;
  const dose = request.candidate.dose;
  // Reached only when the caller declared DOSE_RANGE available, so
  // neither null here means "we could not read the dose" — that case
  // is a gap and never gets this far. `range === null` is the
  // knowledge source answering "no published envelope for this drug",
  // the same class of answer as having no cross-sensitivity data for
  // a substance, and gapping on it would fire on every drug a
  // database chooses not to grade. `dose === null` is the caller
  // stating this prescription carries no dose to compare.
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
        // Same shape of hazard as the numeric dose findings at lower
        // stakes: the drug code alone would let an acknowledgement of
        // one unit pairing suppress a different one.
        qualifiers: [`doseUnit=${dose.unit}`, `rangeUnit=${range.unit}`],
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
        // The magnitude IS the finding here. Without it in the
        // identity, acknowledging a dose slightly over the maximum
        // would suppress one many times over it — see `fingerprintOf`.
        qualifiers: [
          `dose=${dose.amount}${dose.unit}`,
          `limit=${range.maxSingleDose}${range.unit}`,
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
        // The daily total rather than amount-and-frequency separately:
        // it is what the reason states, and two regimens reaching the
        // same total are the same thing to acknowledge.
        qualifiers: [
          `dailyTotal=${dailyTotal}${dose.unit}`,
          `limit=${range.maxDailyDose}${range.unit}`,
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
        qualifiers: [
          `dailyTotal=${dailyTotal}${dose.unit}`,
          `limit=${range.minDailyDose}${range.unit}`,
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
  /**
   * Required, not optional, so that adding a finding kind forces a
   * decision instead of defaulting to the unsafe answer. List every
   * value `reason` interpolates that is not already a trigger code;
   * `[]` is correct only when the trigger codes are the whole story.
   * See `fingerprintOf` for what goes wrong when this is understated.
   */
  readonly qualifiers: ReadonlyArray<string>;
  readonly citation: string | null;
}

/**
 * Disposition and fingerprint are derived here and nowhere else, so no
 * call site can mint a finding that blocks without going through
 * `dispositionFor`, or one whose identity omits part of what it says.
 */
function finding(draft: FindingDraft): ScreeningFinding {
  // `qualifiers` deliberately does not survive onto the finding: it is
  // an input to identity, and everything in it is already legible to a
  // reader in `reason`. Persisting it too would widen the event
  // payload to say the same thing a third time.
  return {
    code: draft.code,
    kind: draft.kind,
    severity: draft.severity,
    certainty: draft.certainty,
    reason: draft.reason,
    triggers: draft.triggers,
    citation: draft.citation,
    disposition: dispositionFor(draft.severity, draft.certainty),
    fingerprint: fingerprintOf(draft),
  };
}

/**
 * `coverage` decides the grade, for the same reason an input axis's
 * declaration does.
 *
 * A PROVISIONED source that does not recognise one code has a fixable
 * hole in it: the NDC may be wrong, or the vendor may owe an update,
 * and a pharmacist is right to be asked. A NOT_PROVISIONED source will
 * fail every lookup for every drug on every order until somebody buys
 * a licence — an acknowledgement per prescription cannot close that
 * and only spends the pharmacist's attention on the way to not closing
 * it. Both are recorded identically; only the interruption differs.
 */
function knowledgeGapFinding(
  source: "CANDIDATE_DRUG" | "PROFILE_MEDICATION",
  drug: PrescribedDrug,
  coverage: DrugKnowledgeCoverage
): ScreeningFinding {
  const scope =
    source === "CANDIDATE_DRUG"
      ? "no screening could be performed for this prescription"
      : "this profile medication was excluded from interaction and duplication screening";
  const remediation = gapRemediationForCoverage(coverage);
  return finding({
    code: "SCR_KNOWLEDGE_UNAVAILABLE",
    kind: "SCREENING_GAP",
    // Never high enough to block, at either grade: refusing to
    // dispense because our reference data is incomplete would make a
    // gap in our knowledge the patient's problem.
    severity: screeningGapSeverity(remediation),
    certainty: "DEFINITE",
    reason: `No drug knowledge is available for ${drug.drugCode}; ${scope}. ${KNOWLEDGE_REMEDIATION_REASON[remediation]}`,
    triggers: [trigger(source, drug.recordId, drug.drugCode)],
    // The two scopes read differently and mean different things — one
    // says nothing was screened at all — but the trigger CODE is the
    // drug either way, and trigger sources are excluded from identity
    // by design. A drug that was an unscreenable profile entry last
    // month and is the prescription itself this month would otherwise
    // reuse the earlier acknowledgement.
    qualifiers: [`scope=${source}`, `remediation=${remediation}`],
    citation: null,
  });
}

const KNOWLEDGE_REMEDIATION_REASON: Readonly<Record<ScreeningGapRemediation, string>> =
  Object.freeze({
    SUBJECT_DATA:
      "The drug knowledge source is provisioned but holds no record of this code; verify the code and request a reference-data update.",
    PLATFORM_CAPABILITY:
      "No drug knowledge source is provisioned for this deployment, so no prescription can be screened against one until a licensed source is wired.",
  });

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
 *
 * This matches on fingerprint alone, which is safe only because the
 * fingerprint carries the grading and every varying value in the
 * reason. Anything left out of it is something a stale acknowledgement
 * would silently swallow, so read `fingerprintOf` before changing what
 * goes into one.
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
