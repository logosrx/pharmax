// Deterministic typing validation (typing-assist phase 1).
//
// Pure function: a typed prescription draft, the catalog product it
// resolves to, the tenant's guardrail for that product, and the org's
// AI-assist policy go in; a list of findings comes out. No database,
// no clock beyond the injected `today`, no model. Everything this
// module flags is flagged with certainty — the fuzzy layer (model
// suggestions) arrives in a later phase and is bounded by the same
// guardrail values validated here.
//
// Severity semantics:
//   ERROR   — the draft states something internally impossible or
//             outside a tenant-authored ceiling. The typing UI should
//             block completion until resolved or corrected.
//   WARNING — suspicious but conceivably intentional. Surfaced, never
//             blocking; the tech's judgement stands.
//
// PHI note: findings reference FIELD NAMES and numeric/coded values
// only (quantities, day counts, schedules, dates). No sig text, no
// patient identity, nothing encrypted — a finding must be safe to
// log, put in an audit row, and show on a dashboard.

// ---------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------

/** The typed fields the validators reason about. A subset of the
 *  Prescription row, all non-PHI. Dates are ISO `YYYY-MM-DD`. */
export interface TypingDraft {
  readonly quantityAuthorized: number;
  readonly daysSupply: number;
  readonly refillsAuthorized: number;
  readonly refillsRemaining: number;
  readonly originalDateWritten: string;
  readonly expiresAt: string;
  /** DAW code 0–9. */
  readonly daw: number;
  /** DEA schedule snapshot the typist selected for this prescription. */
  readonly controlledSubstanceSchedule: ControlledSchedule;
  /** Earliest-fill date for multi-Rx Schedule II sequences; null =
   *  fillable immediately. */
  readonly earliestFillDate: string | null;
}

export type ControlledSchedule = "NON_CONTROLLED" | "CII" | "CIII" | "CIV" | "CV";

/** Catalog identity of the product the draft resolves to. */
export interface ProductFacts {
  readonly controlledSubstanceSchedule: ControlledSchedule;
}

/** Tenant guardrail values (null = axis unbounded). `null` guardrail
 *  object = tenant never authored one for this product. */
export interface GuardrailFacts {
  readonly aiSuggestionsEnabled: boolean;
  readonly maxQuantityPerFill: number | null;
  readonly maxDaysSupplyPerFill: number | null;
  readonly maxRefillsAuthorized: number | null;
  readonly version: number;
}

/** Org policy values. `null` = org never wrote a policy row, which
 *  means every model-facing switch is at its off/conservative default. */
export interface PolicyFacts {
  readonly typingAssistEnabled: boolean;
  readonly allowControlledSubstanceSuggestions: boolean;
  readonly version: number;
}

export interface EvaluateTypingDraftInput {
  readonly draft: TypingDraft;
  readonly product: ProductFacts;
  readonly guardrail: GuardrailFacts | null;
  readonly policy: PolicyFacts | null;
  /** ISO `YYYY-MM-DD`; injected so evaluation is reproducible. */
  readonly today: string;
}

// ---------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------

export type TypingFindingSeverity = "ERROR" | "WARNING";

export const TYPING_FINDING_CODES = [
  // Internal-consistency (always-on, no guardrail needed).
  "TA_REFILLS_REMAINING_EXCEEDS_AUTHORIZED",
  "TA_EXPIRES_BEFORE_WRITTEN",
  "TA_EXPIRED_AT_TYPING",
  "TA_WRITTEN_IN_FUTURE",
  "TA_DAW_OUT_OF_RANGE",
  "TA_EARLIEST_FILL_BEFORE_WRITTEN",
  "TA_EARLIEST_FILL_ON_NON_CII",
  // Controlled-substance coherence against the catalog.
  "TA_SCHEDULE_MISMATCH_WITH_CATALOG",
  "TA_CII_WITH_REFILLS",
  "TA_CIII_TO_CV_REFILLS_OVER_FIVE",
  // Tenant guardrail ceilings.
  "TA_QUANTITY_EXCEEDS_GUARDRAIL",
  "TA_DAYS_SUPPLY_EXCEEDS_GUARDRAIL",
  "TA_REFILLS_EXCEED_GUARDRAIL",
] as const;

export type TypingFindingCode = (typeof TYPING_FINDING_CODES)[number];

export interface TypingFinding {
  readonly code: TypingFindingCode;
  readonly severity: TypingFindingSeverity;
  /** Draft field(s) the finding is about. */
  readonly fields: ReadonlyArray<keyof TypingDraft>;
  /** PHI-free human-readable explanation. */
  readonly message: string;
  /** PHI-free structured values for the UI / reporting. */
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TypingDraftEvaluation {
  readonly findings: ReadonlyArray<TypingFinding>;
  /** True when at least one ERROR finding is present. UI hint only —
   *  CompleteTypingReview stays the backend gate. */
  readonly hasBlockingFindings: boolean;
  /**
   * Whether MODEL suggestions may be generated/surfaced for this
   * draft, derived from org policy + product guardrail + schedule.
   * Deterministic findings above are produced regardless — turning
   * the model off never turns safety checks off.
   */
  readonly modelSuggestionsPermitted: boolean;
  /** Revision pins for downstream suggestion records. */
  readonly guardrailVersion: number | null;
  readonly policyVersion: number | null;
}

// ---------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------

function isControlled(schedule: ControlledSchedule): boolean {
  return schedule !== "NON_CONTROLLED";
}

export function evaluateTypingDraft(input: EvaluateTypingDraftInput): TypingDraftEvaluation {
  const { draft, product, guardrail, policy, today } = input;
  const findings: TypingFinding[] = [];

  // --- Internal consistency -------------------------------------------

  if (draft.refillsRemaining > draft.refillsAuthorized) {
    findings.push({
      code: "TA_REFILLS_REMAINING_EXCEEDS_AUTHORIZED",
      severity: "ERROR",
      fields: ["refillsRemaining", "refillsAuthorized"],
      message: "Refills remaining exceeds refills authorized.",
      context: {
        refillsRemaining: draft.refillsRemaining,
        refillsAuthorized: draft.refillsAuthorized,
      },
    });
  }

  if (draft.expiresAt <= draft.originalDateWritten) {
    findings.push({
      code: "TA_EXPIRES_BEFORE_WRITTEN",
      severity: "ERROR",
      fields: ["expiresAt", "originalDateWritten"],
      message: "The prescription expires on or before the date it was written.",
      context: { expiresAt: draft.expiresAt, originalDateWritten: draft.originalDateWritten },
    });
  }

  if (draft.expiresAt < today) {
    findings.push({
      code: "TA_EXPIRED_AT_TYPING",
      severity: "ERROR",
      fields: ["expiresAt"],
      message: "The prescription is already expired.",
      context: { expiresAt: draft.expiresAt, today },
    });
  }

  if (draft.originalDateWritten > today) {
    findings.push({
      code: "TA_WRITTEN_IN_FUTURE",
      severity: "WARNING",
      fields: ["originalDateWritten"],
      message:
        "The written date is in the future — likely a transposed date. Verify against the source document.",
      context: { originalDateWritten: draft.originalDateWritten, today },
    });
  }

  if (!Number.isInteger(draft.daw) || draft.daw < 0 || draft.daw > 9) {
    findings.push({
      code: "TA_DAW_OUT_OF_RANGE",
      severity: "ERROR",
      fields: ["daw"],
      message: "DAW code must be an integer 0–9.",
      context: { daw: draft.daw },
    });
  }

  if (draft.earliestFillDate !== null) {
    if (draft.earliestFillDate < draft.originalDateWritten) {
      findings.push({
        code: "TA_EARLIEST_FILL_BEFORE_WRITTEN",
        severity: "ERROR",
        fields: ["earliestFillDate", "originalDateWritten"],
        message: "Earliest fill date precedes the written date.",
        context: {
          earliestFillDate: draft.earliestFillDate,
          originalDateWritten: draft.originalDateWritten,
        },
      });
    }
    if (draft.controlledSubstanceSchedule !== "CII") {
      findings.push({
        code: "TA_EARLIEST_FILL_ON_NON_CII",
        severity: "WARNING",
        fields: ["earliestFillDate", "controlledSubstanceSchedule"],
        message:
          "An earliest-fill date is a Schedule II multiple-prescription instruction (21 CFR 1306.12); it is unusual on this schedule.",
        context: {
          earliestFillDate: draft.earliestFillDate,
          schedule: draft.controlledSubstanceSchedule,
        },
      });
    }
  }

  // --- Controlled-substance coherence ---------------------------------

  if (draft.controlledSubstanceSchedule !== product.controlledSubstanceSchedule) {
    findings.push({
      code: "TA_SCHEDULE_MISMATCH_WITH_CATALOG",
      severity: "ERROR",
      fields: ["controlledSubstanceSchedule"],
      message:
        "The schedule typed on the prescription does not match the catalog product's DEA schedule.",
      context: {
        typedSchedule: draft.controlledSubstanceSchedule,
        catalogSchedule: product.controlledSubstanceSchedule,
      },
    });
  }

  if (draft.controlledSubstanceSchedule === "CII" && draft.refillsAuthorized > 0) {
    findings.push({
      code: "TA_CII_WITH_REFILLS",
      severity: "ERROR",
      fields: ["refillsAuthorized", "controlledSubstanceSchedule"],
      message: "Schedule II prescriptions cannot authorize refills (21 CFR 1306.12).",
      context: { refillsAuthorized: draft.refillsAuthorized },
    });
  }

  if (
    (draft.controlledSubstanceSchedule === "CIII" ||
      draft.controlledSubstanceSchedule === "CIV" ||
      draft.controlledSubstanceSchedule === "CV") &&
    draft.refillsAuthorized > 5
  ) {
    findings.push({
      code: "TA_CIII_TO_CV_REFILLS_OVER_FIVE",
      severity: "ERROR",
      fields: ["refillsAuthorized", "controlledSubstanceSchedule"],
      message: "Schedule III–V prescriptions may be refilled at most 5 times (21 CFR 1306.22).",
      context: {
        refillsAuthorized: draft.refillsAuthorized,
        schedule: draft.controlledSubstanceSchedule,
      },
    });
  }

  // --- Tenant guardrail ceilings ---------------------------------------

  if (guardrail !== null) {
    if (
      guardrail.maxQuantityPerFill !== null &&
      draft.quantityAuthorized > guardrail.maxQuantityPerFill
    ) {
      findings.push({
        code: "TA_QUANTITY_EXCEEDS_GUARDRAIL",
        severity: "ERROR",
        fields: ["quantityAuthorized"],
        message: "Quantity exceeds this pharmacy's per-fill ceiling for the product.",
        context: {
          quantityAuthorized: draft.quantityAuthorized,
          maxQuantityPerFill: guardrail.maxQuantityPerFill,
          guardrailVersion: guardrail.version,
        },
      });
    }
    if (
      guardrail.maxDaysSupplyPerFill !== null &&
      draft.daysSupply > guardrail.maxDaysSupplyPerFill
    ) {
      findings.push({
        code: "TA_DAYS_SUPPLY_EXCEEDS_GUARDRAIL",
        severity: "ERROR",
        fields: ["daysSupply"],
        message: "Days supply exceeds this pharmacy's ceiling for the product.",
        context: {
          daysSupply: draft.daysSupply,
          maxDaysSupplyPerFill: guardrail.maxDaysSupplyPerFill,
          guardrailVersion: guardrail.version,
        },
      });
    }
    if (
      guardrail.maxRefillsAuthorized !== null &&
      draft.refillsAuthorized > guardrail.maxRefillsAuthorized
    ) {
      findings.push({
        code: "TA_REFILLS_EXCEED_GUARDRAIL",
        severity: "ERROR",
        fields: ["refillsAuthorized"],
        message: "Refills authorized exceeds this pharmacy's ceiling for the product.",
        context: {
          refillsAuthorized: draft.refillsAuthorized,
          maxRefillsAuthorized: guardrail.maxRefillsAuthorized,
          guardrailVersion: guardrail.version,
        },
      });
    }
  }

  // --- Model-suggestion gate --------------------------------------------
  //
  // Every switch fails CLOSED: no policy row → no model; guardrail
  // kill switch → no model; controlled substance without the explicit
  // org opt-in → no model. The catalog schedule participates too, so
  // a typist mistyping NON_CONTROLLED on a controlled product cannot
  // open the gate their mistake should have closed.

  const modelSuggestionsPermitted =
    policy !== null &&
    policy.typingAssistEnabled &&
    (guardrail === null || guardrail.aiSuggestionsEnabled) &&
    (!isControlled(draft.controlledSubstanceSchedule) &&
    !isControlled(product.controlledSubstanceSchedule)
      ? true
      : policy.allowControlledSubstanceSuggestions);

  return {
    findings,
    hasBlockingFindings: findings.some((f) => f.severity === "ERROR"),
    modelSuggestionsPermitted,
    guardrailVersion: guardrail?.version ?? null,
    policyVersion: policy?.version ?? null,
  };
}
