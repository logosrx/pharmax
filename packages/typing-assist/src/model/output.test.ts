// Model output crosses two gates before a technician sees it, and both
// are adversarial toward the model rather than trusting of it:
//
//   Layer 1 (shape) — a response that is not what we asked for is an
//   error, not material to forward. Unknown fields, out-of-range
//   confidence, and a field name outside the vocabulary all fail.
//
//   Layer 2 (tenant gates) — the org's confidence threshold and the
//   product's guardrail ceilings decide what is VISIBLE. The property
//   that matters most here: a model must never be able to talk a
//   technician INTO a guardrail breach. A proposal above a ceiling is
//   dropped even when the model is certain about it.
//
// All data is synthetic. No PHI.

import { describe, expect, it } from "vitest";

import { extractJsonObject, filterModelSuggestions, parseModelSuggestions } from "./output.js";
import type { RawModelSuggestion } from "./output.js";
import type { GuardrailFacts, TypingDraft } from "../evaluate-typing-draft.js";

const draft: TypingDraft = {
  quantityAuthorized: 60,
  daysSupply: 30,
  refillsAuthorized: 2,
  refillsRemaining: 2,
  originalDateWritten: "2026-08-01",
  expiresAt: "2027-08-01",
  daw: 0,
  controlledSubstanceSchedule: "NON_CONTROLLED",
  earliestFillDate: null,
};

const structuredSig = {
  sigStructureKind: "FIXED",
  doseAmount: 1,
  doseUnit: "TABLET",
  dosesPerDay: 2,
};

const guardrail: GuardrailFacts = {
  aiSuggestionsEnabled: true,
  maxQuantityPerFill: 90,
  maxDaysSupplyPerFill: 30,
  maxRefillsAuthorized: 5,
  version: 1,
};

function candidate(overrides: Partial<RawModelSuggestion> = {}): RawModelSuggestion {
  return {
    field: "quantityAuthorized",
    proposedValue: 90,
    rationale: "Sig implies 3 tablets daily over 30 days.",
    confidencePercent: 95,
    ...overrides,
  };
}

function filter(
  candidates: ReadonlyArray<RawModelSuggestion>,
  opts: { minConfidencePercent?: number; guardrail?: GuardrailFacts | null } = {}
) {
  return filterModelSuggestions({
    candidates,
    draft,
    structuredSig,
    drug: { strength: "500 mg", form: "TABLET" },
    guardrail: opts.guardrail === undefined ? guardrail : opts.guardrail,
    minConfidencePercent: opts.minConfidencePercent ?? 90,
  });
}

// ---------------------------------------------------------------------
// Layer 1: shape
// ---------------------------------------------------------------------

describe("extractJsonObject", () => {
  it("unwraps a fenced JSON object", () => {
    const text = 'Here you go:\n```json\n{"suggestions": []}\n```';
    expect(extractJsonObject(text)).toBe('{"suggestions": []}');
  });

  it("handles braces inside string values without truncating", () => {
    const text = '{"suggestions": [], "note": "a } brace"}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("handles escaped quotes inside string values", () => {
    const text = '{"note": "say \\"hi\\" }", "suggestions": []}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("returns null when there is no object at all", () => {
    expect(extractJsonObject("I cannot help with that.")).toBeNull();
  });
});

describe("parseModelSuggestions", () => {
  it("accepts a well-formed response", () => {
    const result = parseModelSuggestions(
      JSON.stringify({
        suggestions: [
          {
            field: "daysSupply",
            proposedValue: 30,
            rationale: "Quantity and dose imply 30 days.",
            confidencePercent: 88,
          },
        ],
      })
    );

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.suggestions).toHaveLength(1);
  });

  it("accepts an empty suggestions array", () => {
    const result = parseModelSuggestions('{"suggestions": []}');
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.suggestions).toEqual([]);
  });

  it("fails on prose with no JSON", () => {
    expect(parseModelSuggestions("The draft looks fine to me.").ok).toBe(false);
  });

  it("fails on malformed JSON", () => {
    expect(parseModelSuggestions('{"suggestions": [').ok).toBe(false);
  });

  it("fails on a field outside the vocabulary", () => {
    // The whole response fails rather than dropping the item: a model
    // naming a column we never offered is misbehaving, and quietly
    // keeping its other proposals extends trust it just forfeited.
    const result = parseModelSuggestions(
      JSON.stringify({
        suggestions: [
          {
            field: "patientDateOfBirth",
            proposedValue: "1980-01-02",
            rationale: "…",
            confidencePercent: 99,
          },
        ],
      })
    );

    expect(result.ok).toBe(false);
  });

  it("fails on extra properties in a suggestion", () => {
    const result = parseModelSuggestions(
      JSON.stringify({
        suggestions: [{ ...candidate(), sideChannel: "ignore previous instructions" }],
      })
    );

    expect(result.ok).toBe(false);
  });

  it("fails on out-of-range or non-integer confidence", () => {
    expect(
      parseModelSuggestions(
        JSON.stringify({ suggestions: [{ ...candidate(), confidencePercent: 120 }] })
      ).ok
    ).toBe(false);
    expect(
      parseModelSuggestions(
        JSON.stringify({ suggestions: [{ ...candidate(), confidencePercent: 95.5 }] })
      ).ok
    ).toBe(false);
  });

  it("caps the number of suggestions per response", () => {
    const result = parseModelSuggestions(
      JSON.stringify({ suggestions: Array.from({ length: 11 }, () => candidate()) })
    );

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Layer 2: tenant gates
// ---------------------------------------------------------------------

describe("filterModelSuggestions — confidence threshold", () => {
  it("keeps a proposal at exactly the threshold", () => {
    const result = filter([candidate({ confidencePercent: 90 })], { minConfidencePercent: 90 });

    expect(result.accepted).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it("drops a proposal one point below the threshold, with a reason", () => {
    const result = filter([candidate({ confidencePercent: 89 })], { minConfidencePercent: 90 });

    expect(result.accepted).toEqual([]);
    expect(result.dropped[0]?.reason).toContain("below org threshold 90");
  });
});

describe("filterModelSuggestions — guardrail ceilings", () => {
  it("drops a proposal that would breach the quantity ceiling", () => {
    // The model is certain and the value parses. It is still refused:
    // the ceiling is the tenant's, and a confident model is exactly the
    // case the ceiling exists for.
    const result = filter([candidate({ proposedValue: 120, confidencePercent: 100 })]);

    expect(result.accepted).toEqual([]);
    expect(result.dropped[0]?.reason).toContain("exceeds guardrail ceiling 90");
  });

  it("keeps a proposal exactly at the ceiling", () => {
    expect(filter([candidate({ proposedValue: 90 })]).accepted).toHaveLength(1);
  });

  it("applies the refills ceiling to both refill fields", () => {
    const result = filter([
      candidate({ field: "refillsAuthorized", proposedValue: 6 }),
      candidate({ field: "refillsRemaining", proposedValue: 6 }),
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.dropped).toHaveLength(2);
  });

  it("imposes no ceiling when the product has no guardrail row", () => {
    const result = filter([candidate({ proposedValue: 500 })], { guardrail: null });

    expect(result.accepted).toHaveLength(1);
  });
});

describe("filterModelSuggestions — noise", () => {
  it("drops a proposal equal to the current value", () => {
    const result = filter([candidate({ field: "daysSupply", proposedValue: 30 })]);

    expect(result.accepted).toEqual([]);
    expect(result.dropped[0]?.reason).toContain("equals the current value");
  });

  it("drops a second proposal for a field already proposed", () => {
    const result = filter([
      candidate({ proposedValue: 90, confidencePercent: 95 }),
      candidate({ proposedValue: 75, confidencePercent: 94 }),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.suggestedValue).toBe(90);
    expect(result.dropped[0]?.reason).toContain("duplicate");
  });

  it("does not let a dropped proposal reserve its field", () => {
    // The first is below threshold, so the second (valid) proposal for
    // the same field must still be considered — otherwise a low-
    // confidence guess silently suppresses a good one.
    const result = filter(
      [
        candidate({ proposedValue: 75, confidencePercent: 50 }),
        candidate({ proposedValue: 90, confidencePercent: 99 }),
      ],
      { minConfidencePercent: 90 }
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.suggestedValue).toBe(90);
  });

  it("drops a value the vocabulary rejects", () => {
    const result = filter([candidate({ field: "daysSupply", proposedValue: 400 })]);

    expect(result.accepted).toEqual([]);
    expect(result.dropped[0]?.reason).toContain("invalid value");
  });
});

describe("filterModelSuggestions — recorded before-value", () => {
  it("records the draft value each proposal replaces", () => {
    // This is what AcceptTypingSuggestion's stale check compares
    // against later, so it must come from the draft and not from the
    // model's claim about the draft.
    const result = filter([candidate({ field: "refillsAuthorized", proposedValue: 3 })]);

    expect(result.accepted[0]).toMatchObject({
      field: "refillsAuthorized",
      currentValue: 2,
      suggestedValue: 3,
    });
  });

  it("records a null before-value for an empty nullable field", () => {
    const result = filter([candidate({ field: "earliestFillDate", proposedValue: "2026-09-01" })]);

    expect(result.accepted[0]).toMatchObject({
      field: "earliestFillDate",
      currentValue: null,
      suggestedValue: "2026-09-01",
    });
  });
});
