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
] as const);

export type ScreeningFindingCode = (typeof SCREENING_FINDING_CODES)[number];

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

/**
 * Stable identity for "this clinical situation", used to dedupe within
 * one screen and to carry a pharmacist's acknowledgement forward
 * across screens.
 *
 * Built from the finding code plus the SORTED SET OF CONTRIBUTING
 * CODES — deliberately not from the trigger record ids, and not from
 * the trigger sources. Two consequences, both intended:
 *
 *   - A refill re-screens to the same fingerprint as the original, so
 *     an acknowledgement recorded in January is not demanded again in
 *     February for an unchanged profile.
 *   - An A-against-B interaction fingerprints identically to B-against-A,
 *     so swapping which of the two drugs is the one being dispensed does
 *     not resurrect a settled alert.
 *
 * The record ids stay on `triggers`, where the audit trail needs them.
 */
export function fingerprintOf(
  code: ScreeningFindingCode,
  triggers: ReadonlyArray<ScreeningTrigger>
): string {
  const codes = [...new Set(triggers.map((t) => t.code))].sort((a, b) => a.localeCompare(b));
  return `${code}|${codes.join("+")}`;
}

/**
 * The PV1 rejection-reason code a pharmacist would most likely pick if
 * they rejected on the strength of this finding.
 *
 * A HINT for the UI to preselect, not a decision — the pharmacist
 * chooses, and `RejectPV1` validates against its own registry.
 *
 * SYNC HAZARD: these strings are members of `PV1_REJECTION_REASONS` in
 * `@pharmax/verification`, reproduced rather than imported because
 * this package sits below the domain tier and must not depend on a
 * domain package. The PR that wires screening into PV1 owns a test
 * pinning these against that registry.
 */
export type SuggestedPv1RejectionReason =
  "DRUG_INTERACTION" | "ALLERGY_CONFLICT" | "DUPLICATE_THERAPY" | "DOSE_INCORRECT";

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
