// Unit tests for the Beyond-Use Date predicate.
//
// This predicate is shared by StartDispensingCompoundBatch and both
// console read surfaces precisely so they cannot disagree, so the
// boundary cases below are the contract: the BUD day is dispensable,
// the day after is not, and the answer must not depend on the
// wall-clock time of day.

import { describe, expect, it } from "vitest";

import { isPastBeyondUseDate } from "./compound-batch-bud.js";

// Prisma `@db.Date` hands back midnight UTC of the stored day.
const BUD = new Date("2027-07-02T00:00:00.000Z");

describe("isPastBeyondUseDate", () => {
  it("is false the instant the BUD day begins", () => {
    expect(isPastBeyondUseDate(BUD, new Date("2027-07-02T00:00:00.000Z"))).toBe(false);
  });

  it("is false throughout the BUD day — the batch keeps its last legal day", () => {
    // The regression this predicate exists for: a naive
    // `beyondUseDate < new Date()` reports true from 00:00:01 onward,
    // silently costing the batch its whole final day and putting the
    // console at odds with the command.
    expect(isPastBeyondUseDate(BUD, new Date("2027-07-02T00:00:01.000Z"))).toBe(false);
    expect(isPastBeyondUseDate(BUD, new Date("2027-07-02T12:30:00.000Z"))).toBe(false);
    expect(isPastBeyondUseDate(BUD, new Date("2027-07-02T23:59:59.999Z"))).toBe(false);
  });

  it("is true once the following day begins", () => {
    expect(isPastBeyondUseDate(BUD, new Date("2027-07-03T00:00:00.000Z"))).toBe(true);
    expect(isPastBeyondUseDate(BUD, new Date("2027-08-01T09:00:00.000Z"))).toBe(true);
  });

  it("is false for a BUD in the future", () => {
    expect(isPastBeyondUseDate(BUD, new Date("2027-07-01T23:59:59.999Z"))).toBe(false);
    expect(isPastBeyondUseDate(BUD, new Date("2026-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("does not vary with the time of day within one UTC day", () => {
    const day = "2027-07-05";
    const answers = new Set(
      ["00:00:00", "06:15:00", "12:00:00", "18:45:00", "23:59:59"].map((t) =>
        isPastBeyondUseDate(BUD, new Date(`${day}T${t}.000Z`))
      )
    );
    expect(answers).toEqual(new Set([true]));
  });
});
