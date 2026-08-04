// The screening finding vocabulary: what a finding is, how severe it
// is, how sure we are of it, and — the load-bearing decision — whether
// it stops a fill outright or merely obliges the pharmacist to record
// that they considered it.
//
// PHI INVARIANT. A finding is designed to be persisted verbatim into
// `order_event` / `audit_log` payloads, so it carries NO patient
// identifier, NO free text supplied by a caller, and NO drug NAMES.
// Substances appear only as the opaque codes the caller passed in, and
// `reason` is templated from those codes by this package. Rendering a
// code as "amoxicillin 500mg" is the operator console's job, inside an
// authorized session — not the audit record's.
//
// SEVERITY IS OURS; THE FHIR MAPPING IS THE INTEROP CONTRACT. The four
// grades below are Pharmax's own scale, defined here in the open. They
// are deliberately NOT lifted from any licensed clinical database's
// severity taxonomy. `toFhirDetectedIssueSeverity` projects them onto
// the three public values of FHIR R4 `DetectedIssue.severity`
// (high | moderate | low), which is the standard representation of
// exactly what a finding is and the shape any external consumer should
// receive.

export const SCREENING_SEVERITIES = Object.freeze([
  /** Should not be dispensed as written. The top of the scale. */
  "CONTRAINDICATED",
  /** Capable of serious harm; needs a pharmacist's judgement. */
  "MAJOR",
  /** Worth a look, routinely dispensable with monitoring. */
  "MODERATE",
  /** Noise floor: recorded for the trail, not worth interrupting for. */
  "MINOR",
] as const);

export type ScreeningSeverity = (typeof SCREENING_SEVERITIES)[number];

/**
 * How much the engine trusts the assertion behind a finding.
 *
 * This is a SEPARATE axis from severity, and keeping it separate is
 * the reason this engine can hard-stop without being clicked through.
 * "Patient is confirmed anaphylactic to this exact ingredient" and
 * "this drug shares a cross-sensitivity class with something the
 * patient reacted to once" can both be life-threatening, but only the
 * first is a fact — the second is an inference the pharmacist is
 * better placed to judge than we are.
 */
export const SCREENING_CERTAINTIES = Object.freeze([
  /** Exact-match fact: same coded substance, or an explicit assertion. */
  "DEFINITE",
  /** Asserted, but from a record the pharmacy has not confirmed. */
  "PROBABLE",
  /** Inferred from class membership rather than observed. */
  "POSSIBLE",
] as const);

export type ScreeningCertainty = (typeof SCREENING_CERTAINTIES)[number];

/**
 * What the workflow must do about a finding.
 *
 * ALERT FATIGUE IS THE DESIGN CONSTRAINT. An engine that hard-stops on
 * everything is worse than no engine: the override becomes reflexive,
 * and the one finding that mattered is dismissed with the same
 * keystroke as the ninety that did not. So `HARD_STOP` is deliberately
 * almost unreachable — see `dispositionFor`.
 */
export const SCREENING_DISPOSITIONS = Object.freeze([
  /** No override path. The prescription cannot pass PV1 as written. */
  "HARD_STOP",
  /** Passable, but only against a recorded pharmacist acknowledgement. */
  "REQUIRES_ACKNOWLEDGEMENT",
  /** Surfaced and logged; blocks nothing and interrupts nobody. */
  "INFORMATIONAL",
] as const);

export type ScreeningDisposition = (typeof SCREENING_DISPOSITIONS)[number];

/** The clinical question a finding answers. */
export const SCREENING_FINDING_KINDS = Object.freeze([
  "DRUG_DRUG_INTERACTION",
  "DRUG_ALLERGY",
  "THERAPEUTIC_DUPLICATION",
  "DOSE_RANGE",
  /**
   * Not a clinical finding — a report that some part of the screen
   * could NOT be performed. Without this kind, "no findings" is
   * ambiguous between "screened and clear" and "never screened", and
   * a pharmacist would read the safer meaning into the more dangerous
   * state.
   */
  "SCREENING_GAP",
] as const);

export type ScreeningFindingKind = (typeof SCREENING_FINDING_KINDS)[number];

/**
 * A clinical question the engine answers — equivalently, an input the
 * caller has to be able to supply.
 *
 * DERIVED, NOT DECLARED. This is exactly `SCREENING_FINDING_KINDS`
 * minus the one entry that is not a clinical question, and it is
 * computed rather than written out so the two lists cannot drift.
 * That matters more than it looks: adding a fifth finding kind
 * automatically adds a fifth axis, which makes
 * `ScreeningRequest.inputAvailability` incomplete at every call site
 * and `INPUT_UNAVAILABLE_CODE_FOR_AXIS` incomplete here — both
 * compile errors. The next axis cannot be added silently, which is
 * the property the second-oldest bug in this package lacked.
 */
export type ScreeningInputAxis = Exclude<ScreeningFindingKind, "SCREENING_GAP">;

export const CLINICAL_SCREENING_AXES: ReadonlyArray<ScreeningInputAxis> = Object.freeze(
  SCREENING_FINDING_KINDS.filter((kind): kind is ScreeningInputAxis => kind !== "SCREENING_GAP")
);

/**
 * Whether the caller could supply the facts one axis needs, and — when
 * it could not — WHY NOT.
 *
 * THE FIRST DISTINCTION THIS EXISTS TO DRAW: "this patient has no
 * recorded allergies" and "this platform cannot tell you about
 * allergies" are different clinical facts, and only the second is a
 * gap. An empty array cannot express both — which is how an axis with
 * no input ended up contributing no findings and reading, to a
 * pharmacist, exactly like an axis that ran and found nothing.
 *
 * A genuinely allergy-free patient MUST be able to screen clear on
 * that axis. If unavailability were inferred from emptiness, the gap
 * would fire on every clean patient forever, and a finding that
 * always fires is a finding that gets trained away — the alert
 * fatigue this engine is built to avoid, reintroduced by the
 * mechanism meant to make it safer.
 *
 * THE SECOND DISTINCTION, and the reason there are three values
 * rather than two: a gap the pharmacist can do something about and a
 * gap they cannot are different findings, even though both are true
 * and both must be recorded.
 *
 *   - NOT_RECORDED_FOR_SUBJECT is ACTIONABLE. The platform can hold
 *     this input and nobody supplied it for this patient or this
 *     prescription. Somebody should go and get it, and the person
 *     best placed to start that is the pharmacist looking at the
 *     order. Worth interrupting for.
 *   - NOT_SUPPORTED_BY_PLATFORM is NOT ACTIONABLE by anyone in the
 *     pharmacy. No patient can ever have this input because the
 *     capability does not exist, so the finding is identical on every
 *     order forever. Interrupting for it buys nothing and costs the
 *     one thing a screening engine cannot afford to spend: the
 *     pharmacist's willingness to read the next alert.
 *
 * Collapsing these two into one "UNAVAILABLE" is what made a missing
 * product capability indistinguishable from a missing record, and it
 * is the difference `screeningGapSeverity` grades on. Keeping them
 * apart is also what makes the per-patient prompt come back BY
 * ITSELF: a caller that gains the capability can no longer honestly
 * declare NOT_SUPPORTED_BY_PLATFORM, and the patients with nothing on
 * file start reporting the actionable gap without anyone editing this
 * package.
 *
 * "PARTIAL" is still deliberately absent: a pharmacist cannot act on
 * "some of this patient's allergies are here", and a caller holding an
 * incomplete list should supply what it has and declare AVAILABLE —
 * the same posture the engine already takes toward a knowledge source
 * that answers some lookups and not others.
 */
export const SCREENING_INPUT_AVAILABILITIES = Object.freeze([
  "AVAILABLE",
  "NOT_RECORDED_FOR_SUBJECT",
  "NOT_SUPPORTED_BY_PLATFORM",
] as const);

export type ScreeningInputAvailability = (typeof SCREENING_INPUT_AVAILABILITIES)[number];

/**
 * Who can close a gap — the only question that decides whether a gap
 * interrupts a pharmacist.
 *
 * Derived from an availability declaration by
 * `gapRemediationForAvailability`, and from a knowledge source's
 * `coverage` by `gapRemediationForCoverage`, so the same rule grades
 * both families of gap and neither can drift from the other.
 */
export const SCREENING_GAP_REMEDIATIONS = Object.freeze([
  /**
   * Somebody can supply the missing fact for this patient or this
   * prescription today, using capabilities that already exist.
   */
  "SUBJECT_DATA",
  /**
   * The platform cannot hold or answer this at all. Closing it is a
   * product or procurement change, not something anyone touching this
   * order can do.
   */
  "PLATFORM_CAPABILITY",
] as const);

export type ScreeningGapRemediation = (typeof SCREENING_GAP_REMEDIATIONS)[number];

export function gapRemediationForAvailability(
  availability: Exclude<ScreeningInputAvailability, "AVAILABLE">
): ScreeningGapRemediation {
  switch (availability) {
    case "NOT_RECORDED_FOR_SUBJECT":
      return "SUBJECT_DATA";
    case "NOT_SUPPORTED_BY_PLATFORM":
      return "PLATFORM_CAPABILITY";
    default: {
      const exhaustive: never = availability;
      return exhaustive;
    }
  }
}

/**
 * How severely to grade a `SCREENING_GAP`.
 *
 * A gap has no clinical severity of its own — nobody is harmed by the
 * fact of a missing input, they are harmed by what the missing input
 * would have caught. So severity on a gap has always been used here as
 * the dial that decides whether the pharmacist is interrupted, and
 * this function is that dial made explicit rather than a constant
 * repeated at each emit site.
 *
 *   - SUBJECT_DATA → MODERATE, therefore
 *     REQUIRES_ACKNOWLEDGEMENT. Something is missing that this
 *     pharmacy can supply, and a pharmacist signing off without
 *     noticing is exactly what the acknowledge tier exists to
 *     prevent.
 *   - PLATFORM_CAPABILITY → MINOR, therefore INFORMATIONAL. Recorded,
 *     persisted, and reportable — MINOR is the documented "noise
 *     floor: recorded for the trail, not worth interrupting for", and
 *     that is precisely what a capability we do not have is to the
 *     pharmacist in front of the order.
 *
 * WHY NOT KEEP DEMANDING THE CLICK, WHICH IS SAFER-SOUNDING. Because a
 * finding that fires on 100% of orders is not a finding, it is a
 * loading screen. It trains the dismiss reflex the rest of this
 * package is built to protect, and the first genuine MAJOR interaction
 * is then dismissed by that same reflex — while the audit trail
 * records a pharmacist who considered it. That is strictly worse than
 * no alert, because it manufactures evidence of a review that did not
 * happen. The systemic deficiency still has to be answered for; it is
 * answered at the level that can act on it (a boot-time statement and
 * screening-coverage reporting), not by taxing every order.
 *
 * Neither grade can block, at either end. Refusing to dispense
 * because our platform cannot hold an allergy list would make our
 * missing capability the patient's problem.
 */
export function screeningGapSeverity(remediation: ScreeningGapRemediation): ScreeningSeverity {
  switch (remediation) {
    case "SUBJECT_DATA":
      return "MODERATE";
    case "PLATFORM_CAPABILITY":
      return "MINOR";
    default: {
      const exhaustive: never = remediation;
      return exhaustive;
    }
  }
}

/**
 * Recover a gap's remediation from the severity persisted on its row.
 *
 * For readers of `order_screening_finding`, which stores the grading but
 * not the remediation. The console needs it to decide whether to tell a
 * pharmacist "go and look this up" or "nobody here can close this", and
 * guessing from the finding CODE gets that wrong: since the same code
 * can be raised for either reason, a code-based rule would tell a
 * pharmacist to obtain an allergy history the platform cannot store, or
 * to look up a drug in a database that does not exist.
 *
 * COMPUTED AS THE INVERSE of `screeningGapSeverity` rather than written
 * out, so the two cannot disagree: regrade a remediation there and this
 * follows on its own. Returns `null` for a severity no gap can carry,
 * which is the honest answer for a row this build cannot interpret —
 * `severity` is TEXT precisely so the vocabulary can grow.
 *
 * Only meaningful for `kind = SCREENING_GAP`. A clinical finding's
 * severity says nothing about remediation and callers must check the
 * kind first.
 */
export function gapRemediationFromSeverity(
  severity: ScreeningSeverity
): ScreeningGapRemediation | null {
  return SCREENING_GAP_REMEDIATIONS.find((r) => screeningGapSeverity(r) === severity) ?? null;
}

/**
 * Stable finding codes. These are audit vocabulary: they are written
 * into event payloads and rolled up in reporting, so a code may be
 * ADDED but never renamed or repurposed.
 */
export const SCREENING_FINDING_CODES = Object.freeze([
  "SCR_DRUG_INTERACTION",
  "SCR_DRUG_ALLERGY_DIRECT",
  "SCR_DRUG_ALLERGY_CROSS_SENSITIVITY",
  "SCR_DUPLICATE_INGREDIENT",
  "SCR_DUPLICATE_THERAPEUTIC_CLASS",
  "SCR_DOSE_ABOVE_SINGLE_MAXIMUM",
  "SCR_DOSE_ABOVE_DAILY_MAXIMUM",
  "SCR_DOSE_BELOW_DAILY_MINIMUM",
  "SCR_KNOWLEDGE_UNAVAILABLE",
  "SCR_DOSE_UNIT_NOT_COMPARABLE",
  // One per axis, for the case where the CALLER could not supply the
  // input at all. Distinct from `SCR_KNOWLEDGE_UNAVAILABLE`, which
  // reports that the knowledge source did not recognise a drug we DID
  // ask it about: these say the question was never asked, and the
  // remediation is a different team's (a missing product capability,
  // not a missing row in a licensed database).
  "SCR_INTERACTION_INPUT_UNAVAILABLE",
  "SCR_ALLERGY_INPUT_UNAVAILABLE",
  "SCR_DUPLICATION_INPUT_UNAVAILABLE",
  "SCR_DOSE_INPUT_UNAVAILABLE",
] as const);

export type ScreeningFindingCode = (typeof SCREENING_FINDING_CODES)[number];

/**
 * The finding code that reports each axis as unsupplied.
 *
 * One code per axis rather than one shared code with the axis as a
 * qualifier, because the two are different operational facts with
 * different owners: "we cannot screen allergies" and "we cannot
 * screen doses" are separate tickets, and a dashboard should be able
 * to count them separately without parsing a fingerprint.
 *
 * Exhaustive over `ScreeningInputAxis` by TYPE, which is the forcing
 * function: a new axis does not compile until it has a code here, and
 * `screenPrescription` emits from this map, so the new axis gets gap
 * coverage the moment it exists.
 */
export const INPUT_UNAVAILABLE_CODE_FOR_AXIS: Readonly<
  Record<ScreeningInputAxis, ScreeningFindingCode>
> = Object.freeze({
  DRUG_DRUG_INTERACTION: "SCR_INTERACTION_INPUT_UNAVAILABLE",
  DRUG_ALLERGY: "SCR_ALLERGY_INPUT_UNAVAILABLE",
  THERAPEUTIC_DUPLICATION: "SCR_DUPLICATION_INPUT_UNAVAILABLE",
  DOSE_RANGE: "SCR_DOSE_INPUT_UNAVAILABLE",
});

/** Which side of the screen a trigger came from. */
export const SCREENING_TRIGGER_SOURCES = Object.freeze([
  "CANDIDATE_DRUG",
  "PROFILE_MEDICATION",
  "RECORDED_ALLERGY",
] as const);

export type ScreeningTriggerSource = (typeof SCREENING_TRIGGER_SOURCES)[number];

/**
 * One input that contributed to a finding — the "what set this off"
 * half of the audit trail.
 */
export interface ScreeningTrigger {
  readonly source: ScreeningTriggerSource;
  /**
   * The caller's opaque handle for the contributing record (a
   * prescription-line id, an allergy-record id). Lets a reviewer
   * navigate back to the row months later without the finding itself
   * carrying anything about the patient.
   */
  readonly recordId: string;
  /**
   * The coded concept this input contributed: an ingredient code for
   * an interaction, a substance code for an allergy, a class code
   * where the match was made at class level.
   *
   * For an input-unavailability gap there is no contributing concept
   * — that is the point of it — so the code is the AXIS that could
   * not be screened. Putting it here rather than in a qualifier is
   * deliberate: the axis is then part of the fingerprint through the
   * trigger set, so "we cannot screen allergies" fingerprints
   * identically on every drug and every line, and one acknowledgement
   * settles it for the whole order instead of one per prescription.
   */
  readonly code: string;
}

export interface ScreeningFinding {
  readonly code: ScreeningFindingCode;
  readonly kind: ScreeningFindingKind;
  readonly severity: ScreeningSeverity;
  readonly certainty: ScreeningCertainty;
  readonly disposition: ScreeningDisposition;
  /** Operator-facing explanation, templated from codes. Never PHI. */
  readonly reason: string;
  readonly triggers: ReadonlyArray<ScreeningTrigger>;
  /** Stable identity of the clinical situation. See `fingerprintOf`. */
  readonly fingerprint: string;
  /**
   * Provenance of the underlying assertion, when one exists — supplied
   * by the knowledge source, never invented here. `null` for findings
   * the engine derives structurally (a duplicated ingredient is true
   * by inspection; nobody needs to have published it).
   */
  readonly citation: string | null;
}

const SEVERITY_RANK: Readonly<Record<ScreeningSeverity, number>> = Object.freeze({
  CONTRAINDICATED: 4,
  MAJOR: 3,
  MODERATE: 2,
  MINOR: 1,
});

/** Ordinal rank, ascending with severity. Comparison only. */
export function severityRank(severity: ScreeningSeverity): number {
  return SEVERITY_RANK[severity];
}

/** True when `severity` is at least as severe as `floor`. */
export function isAtLeastAsSevere(severity: ScreeningSeverity, floor: ScreeningSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[floor];
}

/** The less severe of two grades. */
export function leastSevere(a: ScreeningSeverity, b: ScreeningSeverity): ScreeningSeverity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

/** The three public values of FHIR R4 `DetectedIssue.severity`. */
export const FHIR_DETECTED_ISSUE_SEVERITIES = Object.freeze(["high", "moderate", "low"] as const);

export type FhirDetectedIssueSeverity = (typeof FHIR_DETECTED_ISSUE_SEVERITIES)[number];

/**
 * Project our four grades onto FHIR's three.
 *
 * CONTRAINDICATED and MAJOR both land on `high`: FHIR has no fourth
 * value, and collapsing downward would understate a contraindication
 * to an external consumer. The distinction we lose here is preserved
 * in `ScreeningFinding.severity`, which is what Pharmax persists.
 */
export function toFhirDetectedIssueSeverity(
  severity: ScreeningSeverity
): FhirDetectedIssueSeverity {
  switch (severity) {
    case "CONTRAINDICATED":
    case "MAJOR":
      return "high";
    case "MODERATE":
      return "moderate";
    case "MINOR":
      return "low";
    default: {
      const exhaustive: never = severity;
      return exhaustive;
    }
  }
}

/**
 * The hard-stop rule, in one place.
 *
 * A finding blocks ONLY when it is both maximally severe AND certain.
 * Everything else is either an acknowledgement or noise. The reasoning,
 * because this is the decision the whole product turns on:
 *
 *   - Severity alone is not enough. A class-level inference can be
 *     "contraindicated if true", and blocking on it hands the
 *     pharmacist a decision they cannot make and cannot override —
 *     which in practice means the pharmacy turns the feature off.
 *   - Certainty alone is not enough either. We are certain about a
 *     great many minor things.
 *   - A hard stop with no override path is a promise that the finding
 *     is worth a phone call to the prescriber. If the engine cannot
 *     honour that promise every single time, it must not make it.
 *
 * The practical consequence is that only two situations can block.
 * One is a confirmed, high-criticality, immune-mediated allergy to the
 * exact ingredient being dispensed. The other is an interaction the
 * knowledge source itself grades CONTRAINDICATED with DEFINITE
 * certainty — a deliberate "do not dispense" claim by the licensed
 * authority, not an inference of ours.
 *
 * Everything the engine derives structurally is incapable of blocking,
 * by construction rather than by convention: cross-sensitivity is
 * always POSSIBLE, duplication is capped at MAJOR, dose findings at
 * MAJOR, and screening gaps at MODERATE. Each of those has a
 * legitimate clinical case behind it that a pharmacist may know about
 * and we do not.
 */
export function dispositionFor(
  severity: ScreeningSeverity,
  certainty: ScreeningCertainty
): ScreeningDisposition {
  switch (severity) {
    case "CONTRAINDICATED":
      return certainty === "DEFINITE" ? "HARD_STOP" : "REQUIRES_ACKNOWLEDGEMENT";
    case "MAJOR":
    case "MODERATE":
      return "REQUIRES_ACKNOWLEDGEMENT";
    case "MINOR":
      return "INFORMATIONAL";
    default: {
      const exhaustive: never = severity;
      return exhaustive;
    }
  }
}

export interface FingerprintInput {
  readonly code: ScreeningFindingCode;
  readonly severity: ScreeningSeverity;
  readonly certainty: ScreeningCertainty;
  readonly triggers: ReadonlyArray<ScreeningTrigger>;
  /**
   * Every value the finding's `reason` interpolates that is not
   * already a trigger code — magnitudes, units, and any word that
   * varies with the input. See the safety argument below.
   */
  readonly qualifiers: ReadonlyArray<string>;
}

/**
 * Stable identity for "this clinical situation", used to dedupe within
 * one screen and to carry a pharmacist's acknowledgement forward
 * across screens.
 *
 * THE INVARIANT THIS EXISTS TO HOLD: an acknowledgement may suppress
 * only a finding about the situation the pharmacist was actually
 * shown, and never a more severe or differently-worded instance of it.
 * `applyPriorAcknowledgement` downgrades purely on fingerprint match,
 * so anything the fingerprint omits is something a stale
 * acknowledgement can silently swallow — and a suppressed alert is
 * worse than no alert, because its absence actively reassures.
 *
 * Four components, each earning its place:
 *
 *   - THE FINDING CODE, so two kinds of problem never collide.
 *   - THE SORTED SET OF CONTRIBUTING CODES, deliberately NOT the
 *     trigger record ids and NOT the trigger sources. That is what
 *     lets a refill re-screen to the same fingerprint as the original
 *     (an acknowledgement given in January is not demanded again in
 *     February for an unchanged profile), and what makes an
 *     A-against-B interaction fingerprint identically to B-against-A
 *     so that swapping which drug is being dispensed does not
 *     resurrect a settled alert.
 *   - SEVERITY AND CERTAINTY, which make "never a more severe
 *     instance" true by construction rather than by the care of
 *     whoever adds the next finding kind. If a knowledge source
 *     upgrades an interaction from MODERATE to MAJOR, or an allergy
 *     record is confirmed, the fingerprint changes and the pharmacist
 *     is asked again — which is the correct answer, because the
 *     situation they acknowledged is not the situation now in front
 *     of them.
 *   - QUALIFIERS, which close the remaining hole: two findings can be
 *     the same code, same codes, same grading, and still say different
 *     things. A dose finding is the motivating case. Its only trigger
 *     code is the drug, and the magnitude lives in the `reason`
 *     string, so without qualifiers "12 mg daily, above the maximum of
 *     10" and "200 mg daily, above the maximum of 10" are one
 *     fingerprint — and an acknowledgement of the first hides a
 *     tenfold overdose.
 *
 * RULE FOR NEW FINDING KINDS: if two findings would render a different
 * `reason` to a pharmacist, they must not share a fingerprint. In
 * practice that means every value interpolated into `reason` is either
 * a trigger code or a qualifier. `screening.test.ts` pins this
 * generally over a corpus of screens rather than case by case, because
 * the next person to add a finding kind will not read this comment.
 *
 * The record ids stay on `triggers`, where the audit trail needs them.
 */
export function fingerprintOf(input: FingerprintInput): string {
  const codes = [...new Set(input.triggers.map((t) => t.code))].sort((a, b) => a.localeCompare(b));
  // Qualifiers are sorted so identity cannot depend on the order a
  // call site happened to build the array in.
  const qualifiers = [...input.qualifiers].sort((a, b) => a.localeCompare(b));
  const grading = `${input.severity}/${input.certainty}`;
  const base = `${input.code}|${grading}|${codes.join("+")}`;
  return qualifiers.length === 0 ? base : `${base}|${qualifiers.join(";")}`;
}

/**
 * The PV1 rejection-reason code a pharmacist would most likely pick if
 * they rejected on the strength of this finding.
 *
 * A HINT for the UI to preselect, not a decision — the pharmacist
 * chooses, and `RejectPV1` validates against its own registry.
 *
 * These strings are members of `PV1_REJECTION_REASONS` in
 * `@pharmax/verification`, reproduced rather than imported because
 * this package sits below the domain tier and must not depend on a
 * domain package. The duplication is guarded from outside both:
 * `scripts/check-event-reason-mirrors.test.ts` imports this list
 * alongside the registry and fails if a rename there ever leaves a
 * hint here pointing at a code that no longer exists. Do not add a
 * member without checking that test still passes.
 */
export const SUGGESTED_PV1_REJECTION_REASONS = Object.freeze([
  "DRUG_INTERACTION",
  "ALLERGY_CONFLICT",
  "DUPLICATE_THERAPY",
  "DOSE_INCORRECT",
] as const);

export type SuggestedPv1RejectionReason = (typeof SUGGESTED_PV1_REJECTION_REASONS)[number];

export function suggestedPv1RejectionReason(
  kind: ScreeningFindingKind
): SuggestedPv1RejectionReason | null {
  switch (kind) {
    case "DRUG_DRUG_INTERACTION":
      return "DRUG_INTERACTION";
    case "DRUG_ALLERGY":
      return "ALLERGY_CONFLICT";
    case "THERAPEUTIC_DUPLICATION":
      return "DUPLICATE_THERAPY";
    case "DOSE_RANGE":
      return "DOSE_INCORRECT";
    case "SCREENING_GAP":
      // A gap is a reason to go and look something up, never in itself
      // a reason to bounce the prescription back to the typist.
      return null;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
