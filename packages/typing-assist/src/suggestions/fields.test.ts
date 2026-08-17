// The field vocabulary is the PHI boundary and the apply-safety
// boundary at once, so these tests pin both properties:
//
//   1. No encrypted / free-text column is nameable. If someone adds
//      `sig` or `patientNote` to the vocabulary, a suggestion row (and
//      its audit metadata, and the reports built on it) would carry
//      plaintext PHI. The allowlist assertion fails first.
//   2. `parseSuggestionValue` is total and rejects the values a model
//      plausibly emits — a string where a number belongs, a null on a
//      non-nullable field, an out-of-range enum.
//
// All data is synthetic. No PHI.

import { describe, expect, it } from "vitest";

import {
  TYPING_SUGGESTION_FIELDS,
  isTypingSuggestionField,
  parseSuggestionValue,
} from "./fields.js";

describe("field vocabulary — PHI boundary", () => {
  it("contains only the fourteen structured fields we intend", () => {
    // Written out rather than derived: the value of this assertion is
    // that ADDING a field is a deliberate, reviewed edit here.
    expect([...TYPING_SUGGESTION_FIELDS].sort()).toEqual([
      "controlledSubstanceSchedule",
      "daw",
      "daysSupply",
      "doseAmount",
      "doseUnit",
      "dosesPerDay",
      "drugForm",
      "drugStrength",
      "earliestFillDate",
      "expiresAt",
      "quantityAuthorized",
      "refillsAuthorized",
      "refillsRemaining",
      "sigStructureKind",
    ]);
  });

  it("does not admit any free-text or encrypted prescription column", () => {
    for (const forbidden of [
      "sig",
      "sigEnc",
      "patientId",
      "prescriberNote",
      "indication",
      "notes",
      "drugName",
    ]) {
      expect(isTypingSuggestionField(forbidden)).toBe(false);
    }
  });

  it("rejects inherited Object properties as field names", () => {
    // `hasOwnProperty`-based guard, not `in` — otherwise a model
    // naming "constructor" would pass the vocabulary check and reach
    // the accept path's field switch.
    expect(isTypingSuggestionField("constructor")).toBe(false);
    expect(isTypingSuggestionField("toString")).toBe(false);
  });
});

describe("parseSuggestionValue — numeric fields", () => {
  it("accepts a positive quantity and rejects zero, negatives, and strings", () => {
    expect(parseSuggestionValue("quantityAuthorized", 30)).toEqual({ ok: true, value: 30 });
    expect(parseSuggestionValue("quantityAuthorized", 0).ok).toBe(false);
    expect(parseSuggestionValue("quantityAuthorized", -5).ok).toBe(false);
    // A model that emits "30" instead of 30 is a shape error, not a
    // value we coerce: coercion here would let "30 tablets" through.
    expect(parseSuggestionValue("quantityAuthorized", "30").ok).toBe(false);
  });

  it("requires integers for count-shaped fields", () => {
    expect(parseSuggestionValue("daysSupply", 30)).toEqual({ ok: true, value: 30 });
    expect(parseSuggestionValue("daysSupply", 30.5).ok).toBe(false);
    expect(parseSuggestionValue("refillsAuthorized", 2.5).ok).toBe(false);
  });

  it("bounds days supply and refills to plausible ranges", () => {
    expect(parseSuggestionValue("daysSupply", 366).ok).toBe(false);
    expect(parseSuggestionValue("refillsAuthorized", 100).ok).toBe(false);
    expect(parseSuggestionValue("refillsAuthorized", 0)).toEqual({ ok: true, value: 0 });
    expect(parseSuggestionValue("daw", 10).ok).toBe(false);
  });
});

describe("parseSuggestionValue — nullability", () => {
  it("accepts null only where clearing the field is a real proposal", () => {
    expect(parseSuggestionValue("earliestFillDate", null)).toEqual({ ok: true, value: null });
    expect(parseSuggestionValue("doseAmount", null)).toEqual({ ok: true, value: null });

    const refused = parseSuggestionValue("quantityAuthorized", null);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("cannot be cleared");
  });
});

describe("parseSuggestionValue — coded and date fields", () => {
  it("accepts only ISO calendar dates", () => {
    expect(parseSuggestionValue("expiresAt", "2027-03-01")).toEqual({
      ok: true,
      value: "2027-03-01",
    });
    expect(parseSuggestionValue("expiresAt", "03/01/2027").ok).toBe(false);
    expect(parseSuggestionValue("expiresAt", "2027-03-01T00:00:00Z").ok).toBe(false);
  });

  it("accepts only known schedule, sig-structure, and dose-unit codes", () => {
    expect(parseSuggestionValue("controlledSubstanceSchedule", "CII")).toEqual({
      ok: true,
      value: "CII",
    });
    expect(parseSuggestionValue("controlledSubstanceSchedule", "C2").ok).toBe(false);
    expect(parseSuggestionValue("controlledSubstanceSchedule", "Schedule II").ok).toBe(false);
    expect(parseSuggestionValue("sigStructureKind", "PRN")).toEqual({ ok: true, value: "PRN" });
    expect(parseSuggestionValue("sigStructureKind", "AS_NEEDED").ok).toBe(false);
    expect(parseSuggestionValue("doseUnit", "MG")).toEqual({ ok: true, value: "MG" });
    expect(parseSuggestionValue("doseUnit", "mg").ok).toBe(false);
  });

  it("bounds catalog strings so a runaway generation cannot land in a column", () => {
    expect(parseSuggestionValue("drugStrength", "500 mg").ok).toBe(true);
    expect(parseSuggestionValue("drugStrength", "").ok).toBe(false);
    expect(parseSuggestionValue("drugStrength", "x".repeat(101)).ok).toBe(false);
  });
});
