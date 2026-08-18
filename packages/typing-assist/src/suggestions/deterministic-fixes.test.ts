// The deterministic fix generator is the part of the AI panel that
// claims to be arithmetic rather than advice, so these tests pin the
// two properties that claim rests on:
//
//   1. It proposes ONLY where exactly one value is correct. A finding
//      like "expires before written" has many plausible repairs and
//      must produce no proposal — the finding still surfaces and the
//      human investigates.
//   2. Each proposal's value is the regulation's / guardrail's value,
//      and the before-value it records matches the draft (that recorded
//      before-value is what AcceptTypingSuggestion's stale check
//      compares against later).
//
// All data is synthetic. No PHI.

import { describe, expect, it } from "vitest";

import { deterministicFixesForFindings } from "./deterministic-fixes.js";
import type {
  GuardrailFacts,
  ProductFacts,
  TypingDraft,
  TypingFinding,
} from "../evaluate-typing-draft.js";

const draft: TypingDraft = {
  quantityAuthorized: 120,
  daysSupply: 90,
  refillsAuthorized: 8,
  refillsRemaining: 9,
  originalDateWritten: "2026-08-01",
  expiresAt: "2027-08-01",
  daw: 0,
  controlledSubstanceSchedule: "CII",
  earliestFillDate: "2026-09-01",
};

const product: ProductFacts = { controlledSubstanceSchedule: "CIII" };

const guardrail: GuardrailFacts = {
  aiSuggestionsEnabled: true,
  maxQuantityPerFill: 60,
  maxDaysSupplyPerFill: 30,
  maxRefillsAuthorized: 3,
  version: 4,
};

function finding(code: TypingFinding["code"]): TypingFinding {
  // Only `code` steers the generator; the rest is a valid carcass.
  return { code, severity: "ERROR", fields: [], message: code, context: {} };
}

describe("deterministic fixes — regulation-derived values", () => {
  it("aligns refills remaining to the authorized count", () => {
    const fixes = deterministicFixesForFindings({
      draft,
      product,
      guardrail: null,
      findings: [finding("TA_REFILLS_REMAINING_EXCEEDS_AUTHORIZED")],
    });

    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({
      field: "refillsRemaining",
      currentValue: 9,
      suggestedValue: 8,
      findingCode: "TA_REFILLS_REMAINING_EXCEEDS_AUTHORIZED",
    });
  });

  it("zeroes BOTH refill fields for a Schedule II draft that carries them", () => {
    const fixes = deterministicFixesForFindings({
      draft,
      product,
      guardrail: null,
      findings: [finding("TA_CII_WITH_REFILLS")],
    });

    expect(fixes.map((f) => [f.field, f.suggestedValue])).toEqual([
      ["refillsAuthorized", 0],
      ["refillsRemaining", 0],
    ]);
    // The prohibition is the reason, and it is citable.
    expect(fixes[0]?.rationale).toContain("21 CFR 1306.12");
  });

  it("omits the remaining-refills fix when the draft already carries none", () => {
    const fixes = deterministicFixesForFindings({
      draft: { ...draft, refillsRemaining: 0 },
      product,
      guardrail: null,
      findings: [finding("TA_CII_WITH_REFILLS")],
    });

    expect(fixes.map((f) => f.field)).toEqual(["refillsAuthorized"]);
  });

  it("caps Schedule III–V refills at five", () => {
    const fixes = deterministicFixesForFindings({
      draft,
      product,
      guardrail: null,
      findings: [finding("TA_CIII_TO_CV_REFILLS_OVER_FIVE")],
    });

    expect(fixes[0]).toMatchObject({ field: "refillsAuthorized", suggestedValue: 5 });
    expect(fixes[0]?.rationale).toContain("21 CFR 1306.22");
  });

  it("defers to the catalog schedule on a mismatch", () => {
    const fixes = deterministicFixesForFindings({
      draft,
      product,
      guardrail: null,
      findings: [finding("TA_SCHEDULE_MISMATCH_WITH_CATALOG")],
    });

    expect(fixes[0]).toMatchObject({
      field: "controlledSubstanceSchedule",
      currentValue: "CII",
      suggestedValue: "CIII",
    });
  });

  it("proposes clearing an earliest-fill date on a non-CII draft", () => {
    const fixes = deterministicFixesForFindings({
      draft,
      product,
      guardrail: null,
      findings: [finding("TA_EARLIEST_FILL_ON_NON_CII")],
    });

    expect(fixes[0]).toMatchObject({
      field: "earliestFillDate",
      currentValue: "2026-09-01",
      suggestedValue: null,
    });
  });
});

describe("deterministic fixes — guardrail ceilings", () => {
  it("caps quantity, days supply, and refills at the tenant's ceilings", () => {
    const fixes = deterministicFixesForFindings({
      draft,
      product,
      guardrail,
      findings: [
        finding("TA_QUANTITY_EXCEEDS_GUARDRAIL"),
        finding("TA_DAYS_SUPPLY_EXCEEDS_GUARDRAIL"),
        finding("TA_REFILLS_EXCEED_GUARDRAIL"),
      ],
    });

    expect(fixes.map((f) => [f.field, f.suggestedValue])).toEqual([
      ["quantityAuthorized", 60],
      ["daysSupply", 30],
      ["refillsAuthorized", 3],
    ]);
  });

  it("proposes nothing when the ceiling that produced the finding is absent", () => {
    // Defensive: a guardrail row whose ceiling was cleared between
    // evaluation and fix generation must not yield a fix to `null`.
    const fixes = deterministicFixesForFindings({
      draft,
      product,
      guardrail: { ...guardrail, maxQuantityPerFill: null },
      findings: [finding("TA_QUANTITY_EXCEEDS_GUARDRAIL")],
    });

    expect(fixes).toEqual([]);
  });
});

describe("deterministic fixes — refuses to guess", () => {
  it("produces no proposal for findings with more than one plausible repair", () => {
    const fixes = deterministicFixesForFindings({
      draft,
      product,
      guardrail,
      findings: [
        finding("TA_EXPIRES_BEFORE_WRITTEN"),
        finding("TA_EXPIRED_AT_TYPING"),
        finding("TA_WRITTEN_IN_FUTURE"),
        finding("TA_DAW_OUT_OF_RANGE"),
        finding("TA_EARLIEST_FILL_BEFORE_WRITTEN"),
      ],
    });

    expect(fixes).toEqual([]);
  });

  it("keeps only the first proposal when two findings target one field", () => {
    // CII-with-refills wants 0; the guardrail breach wants 3. Showing
    // both would ask the technician to adjudicate between two values
    // each claiming to be certain, so the stricter (earlier) one wins.
    const fixes = deterministicFixesForFindings({
      draft,
      product,
      guardrail,
      findings: [finding("TA_CII_WITH_REFILLS"), finding("TA_REFILLS_EXCEED_GUARDRAIL")],
    });

    const authorized = fixes.filter((f) => f.field === "refillsAuthorized");
    expect(authorized).toHaveLength(1);
    expect(authorized[0]?.suggestedValue).toBe(0);
  });
});
