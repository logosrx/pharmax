// Tests for the deterministic typing validators (typing-assist
// phase 1).
//
// Invariants under test:
//   1. A clean draft produces zero findings and no blocking flag.
//   2. Each internal-consistency rule fires on exactly the bad input
//      it is about, with the right severity.
//   3. Controlled-substance coherence: catalog/typed schedule
//      mismatch, CII-with-refills, CIII–CV refills > 5.
//   4. Guardrail ceilings fire only when a ceiling is set and
//      exceeded; a NULL ceiling means "axis unbounded"; a missing
//      guardrail row validates nothing but the always-on rules.
//   5. The model-suggestion gate fails CLOSED on every switch: no
//      policy row, disabled policy, per-product kill switch, and
//      controlled substances without the explicit opt-in — including
//      when only the CATALOG (not the typed draft) says controlled.
//   6. Version pins surface for downstream suggestion records.
//
// All data is synthetic. No PHI.

import { describe, expect, it } from "vitest";

import {
  evaluateTypingDraft,
  type EvaluateTypingDraftInput,
  type GuardrailFacts,
  type PolicyFacts,
  type TypingDraft,
  type TypingFindingCode,
} from "./evaluate-typing-draft.js";

const TODAY = "2026-08-16";

function cleanDraft(overrides: Partial<TypingDraft> = {}): TypingDraft {
  return {
    quantityAuthorized: 30,
    daysSupply: 30,
    refillsAuthorized: 3,
    refillsRemaining: 3,
    originalDateWritten: "2026-08-10",
    expiresAt: "2027-08-10",
    daw: 0,
    controlledSubstanceSchedule: "NON_CONTROLLED",
    earliestFillDate: null,
    ...overrides,
  };
}

function guardrail(overrides: Partial<GuardrailFacts> = {}): GuardrailFacts {
  return {
    aiSuggestionsEnabled: true,
    maxQuantityPerFill: null,
    maxDaysSupplyPerFill: null,
    maxRefillsAuthorized: null,
    version: 1,
    ...overrides,
  };
}

function policy(overrides: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    typingAssistEnabled: true,
    allowControlledSubstanceSuggestions: false,
    version: 1,
    ...overrides,
  };
}

function evaluate(overrides: Partial<EvaluateTypingDraftInput> = {}) {
  return evaluateTypingDraft({
    draft: cleanDraft(),
    product: { controlledSubstanceSchedule: "NON_CONTROLLED" },
    guardrail: null,
    policy: null,
    today: TODAY,
    ...overrides,
  });
}

function codes(result: ReturnType<typeof evaluateTypingDraft>): TypingFindingCode[] {
  return result.findings.map((f) => f.code);
}

// ---------------------------------------------------------------------
// Clean draft
// ---------------------------------------------------------------------

describe("evaluateTypingDraft — clean draft", () => {
  it("produces zero findings and does not block", () => {
    const result = evaluate();
    expect(result.findings).toHaveLength(0);
    expect(result.hasBlockingFindings).toBe(false);
  });

  it("pins guardrail and policy versions when present", () => {
    const result = evaluate({
      guardrail: guardrail({ version: 7 }),
      policy: policy({ version: 3 }),
    });
    expect(result.guardrailVersion).toBe(7);
    expect(result.policyVersion).toBe(3);
  });

  it("pins null versions when tenant never authored them", () => {
    const result = evaluate();
    expect(result.guardrailVersion).toBeNull();
    expect(result.policyVersion).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Internal consistency
// ---------------------------------------------------------------------

describe("evaluateTypingDraft — internal consistency", () => {
  it("flags refills remaining above refills authorized as ERROR", () => {
    const result = evaluate({
      draft: cleanDraft({ refillsAuthorized: 2, refillsRemaining: 5 }),
    });
    expect(codes(result)).toContain("TA_REFILLS_REMAINING_EXCEEDS_AUTHORIZED");
    expect(result.hasBlockingFindings).toBe(true);
  });

  it("flags an expiration on/before the written date as ERROR", () => {
    const result = evaluate({
      draft: cleanDraft({ originalDateWritten: "2026-08-10", expiresAt: "2026-08-10" }),
    });
    expect(codes(result)).toContain("TA_EXPIRES_BEFORE_WRITTEN");
  });

  it("flags an already-expired prescription as ERROR", () => {
    const result = evaluate({
      draft: cleanDraft({ originalDateWritten: "2025-01-01", expiresAt: "2026-01-01" }),
    });
    expect(codes(result)).toContain("TA_EXPIRED_AT_TYPING");
  });

  it("accepts a prescription expiring today (boundary)", () => {
    const result = evaluate({
      draft: cleanDraft({ originalDateWritten: "2025-08-20", expiresAt: TODAY }),
    });
    expect(codes(result)).not.toContain("TA_EXPIRED_AT_TYPING");
  });

  it("flags a future written date as WARNING, not blocking", () => {
    const result = evaluate({
      draft: cleanDraft({ originalDateWritten: "2026-09-01", expiresAt: "2027-09-01" }),
    });
    const finding = result.findings.find((f) => f.code === "TA_WRITTEN_IN_FUTURE");
    expect(finding?.severity).toBe("WARNING");
    expect(result.hasBlockingFindings).toBe(false);
  });

  it("flags a DAW code outside 0–9 as ERROR", () => {
    const result = evaluate({ draft: cleanDraft({ daw: 12 }) });
    expect(codes(result)).toContain("TA_DAW_OUT_OF_RANGE");
  });

  it("flags an earliest-fill date before the written date as ERROR", () => {
    const result = evaluate({
      draft: cleanDraft({
        controlledSubstanceSchedule: "CII",
        refillsAuthorized: 0,
        refillsRemaining: 0,
        earliestFillDate: "2026-08-01",
      }),
      product: { controlledSubstanceSchedule: "CII" },
    });
    expect(codes(result)).toContain("TA_EARLIEST_FILL_BEFORE_WRITTEN");
  });

  it("warns when an earliest-fill date appears on a non-CII prescription", () => {
    const result = evaluate({
      draft: cleanDraft({ earliestFillDate: "2026-09-01" }),
    });
    const finding = result.findings.find((f) => f.code === "TA_EARLIEST_FILL_ON_NON_CII");
    expect(finding?.severity).toBe("WARNING");
  });
});

// ---------------------------------------------------------------------
// Controlled-substance coherence
// ---------------------------------------------------------------------

describe("evaluateTypingDraft — controlled-substance coherence", () => {
  it("flags a typed schedule that disagrees with the catalog as ERROR", () => {
    const result = evaluate({
      draft: cleanDraft({ controlledSubstanceSchedule: "NON_CONTROLLED" }),
      product: { controlledSubstanceSchedule: "CII" },
    });
    expect(codes(result)).toContain("TA_SCHEDULE_MISMATCH_WITH_CATALOG");
  });

  it("flags refills on a Schedule II prescription as ERROR", () => {
    const result = evaluate({
      draft: cleanDraft({
        controlledSubstanceSchedule: "CII",
        refillsAuthorized: 1,
        refillsRemaining: 1,
      }),
      product: { controlledSubstanceSchedule: "CII" },
    });
    expect(codes(result)).toContain("TA_CII_WITH_REFILLS");
  });

  it("flags more than 5 refills on Schedule III–V as ERROR", () => {
    const result = evaluate({
      draft: cleanDraft({
        controlledSubstanceSchedule: "CIV",
        refillsAuthorized: 6,
        refillsRemaining: 6,
      }),
      product: { controlledSubstanceSchedule: "CIV" },
    });
    expect(codes(result)).toContain("TA_CIII_TO_CV_REFILLS_OVER_FIVE");
  });

  it("accepts exactly 5 refills on Schedule III–V (boundary)", () => {
    const result = evaluate({
      draft: cleanDraft({
        controlledSubstanceSchedule: "CV",
        refillsAuthorized: 5,
        refillsRemaining: 5,
      }),
      product: { controlledSubstanceSchedule: "CV" },
    });
    expect(codes(result)).not.toContain("TA_CIII_TO_CV_REFILLS_OVER_FIVE");
  });
});

// ---------------------------------------------------------------------
// Guardrail ceilings
// ---------------------------------------------------------------------

describe("evaluateTypingDraft — guardrail ceilings", () => {
  it("flags quantity above the tenant ceiling as ERROR with the guardrail version in context", () => {
    const result = evaluate({
      draft: cleanDraft({ quantityAuthorized: 120 }),
      guardrail: guardrail({ maxQuantityPerFill: 90, version: 4 }),
    });
    const finding = result.findings.find((f) => f.code === "TA_QUANTITY_EXCEEDS_GUARDRAIL");
    expect(finding?.severity).toBe("ERROR");
    expect(finding?.context["guardrailVersion"]).toBe(4);
  });

  it("accepts quantity exactly at the ceiling (boundary)", () => {
    const result = evaluate({
      draft: cleanDraft({ quantityAuthorized: 90 }),
      guardrail: guardrail({ maxQuantityPerFill: 90 }),
    });
    expect(codes(result)).not.toContain("TA_QUANTITY_EXCEEDS_GUARDRAIL");
  });

  it("flags days supply above the tenant ceiling", () => {
    const result = evaluate({
      draft: cleanDraft({ daysSupply: 90 }),
      guardrail: guardrail({ maxDaysSupplyPerFill: 30 }),
    });
    expect(codes(result)).toContain("TA_DAYS_SUPPLY_EXCEEDS_GUARDRAIL");
  });

  it("flags refills above the tenant ceiling", () => {
    const result = evaluate({
      draft: cleanDraft({ refillsAuthorized: 4, refillsRemaining: 4 }),
      guardrail: guardrail({ maxRefillsAuthorized: 2 }),
    });
    expect(codes(result)).toContain("TA_REFILLS_EXCEED_GUARDRAIL");
  });

  it("validates nothing guardrail-specific when the axis is unbounded", () => {
    const result = evaluate({
      draft: cleanDraft({ quantityAuthorized: 100000 }),
      guardrail: guardrail(), // all ceilings null
    });
    expect(result.findings).toHaveLength(0);
  });

  it("validates nothing guardrail-specific when no guardrail row exists", () => {
    const result = evaluate({ draft: cleanDraft({ quantityAuthorized: 100000 }) });
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Model-suggestion gate — fails closed on every switch
// ---------------------------------------------------------------------

describe("evaluateTypingDraft — model-suggestion gate", () => {
  it("denies when the org never wrote a policy row", () => {
    const result = evaluate({ policy: null });
    expect(result.modelSuggestionsPermitted).toBe(false);
  });

  it("denies when the org policy is disabled", () => {
    const result = evaluate({ policy: policy({ typingAssistEnabled: false }) });
    expect(result.modelSuggestionsPermitted).toBe(false);
  });

  it("permits a non-controlled draft when the org policy is enabled", () => {
    const result = evaluate({ policy: policy() });
    expect(result.modelSuggestionsPermitted).toBe(true);
  });

  it("denies when the product's guardrail kill switch is off", () => {
    const result = evaluate({
      policy: policy(),
      guardrail: guardrail({ aiSuggestionsEnabled: false }),
    });
    expect(result.modelSuggestionsPermitted).toBe(false);
  });

  it("denies a controlled substance without the explicit org opt-in", () => {
    const result = evaluate({
      draft: cleanDraft({
        controlledSubstanceSchedule: "CIII",
        refillsAuthorized: 2,
        refillsRemaining: 2,
      }),
      product: { controlledSubstanceSchedule: "CIII" },
      policy: policy(), // opt-in false
    });
    expect(result.modelSuggestionsPermitted).toBe(false);
  });

  it("denies when only the CATALOG says controlled (mistyped draft cannot open the gate)", () => {
    const result = evaluate({
      draft: cleanDraft({ controlledSubstanceSchedule: "NON_CONTROLLED" }),
      product: { controlledSubstanceSchedule: "CII" },
      policy: policy(),
    });
    expect(result.modelSuggestionsPermitted).toBe(false);
  });

  it("permits a controlled substance with the explicit org opt-in", () => {
    const result = evaluate({
      draft: cleanDraft({
        controlledSubstanceSchedule: "CV",
        refillsAuthorized: 2,
        refillsRemaining: 2,
      }),
      product: { controlledSubstanceSchedule: "CV" },
      policy: policy({ allowControlledSubstanceSuggestions: true }),
    });
    expect(result.modelSuggestionsPermitted).toBe(true);
  });

  it("keeps producing deterministic findings when the model gate is closed", () => {
    const result = evaluate({
      draft: cleanDraft({ refillsAuthorized: 1, refillsRemaining: 9 }),
      policy: null,
    });
    expect(result.modelSuggestionsPermitted).toBe(false);
    expect(codes(result)).toContain("TA_REFILLS_REMAINING_EXCEEDS_AUTHORIZED");
  });
});
