// The per-kind reading of a structured sig, pinned value by value.
//
// `doseStatementFor` is the one place a prescription row's captured
// numbers become the engine's `DoseStatement`, and every value it
// chooses is clinical policy: the BASIS decides which checks run and
// how findings are worded (a SCHEDULED reading of a PRN would earn
// false sub-therapeutic findings; a MAXIMUM_PERMITTED reading of a
// FIXED regimen would silence them), and an absent ceiling must map to
// `dosesPerDay: 0` — the engine's "skip the daily arithmetic" value —
// never to an invented frequency that would screen a fiction.
//
// The end-to-end suites exercise FIXED and PRN-with-ceiling through
// `run-screen.ts`; this file pins the WHOLE mapping, because a
// mutation that flipped RANGE/TAPER to SCHEDULED or invented a PRN
// ceiling survived every other test in the tree when it was tried
// during review.

import { describe, expect, it } from "vitest";

import { Prisma } from "@pharmax/database";
import type { DoseUnit, SigStructureKind } from "@pharmax/database";

import { doseInputAvailabilityFor, doseStatementFor, doseUnitToken } from "./dose-input.js";

import type { StructuredSigRow } from "./dose-input.js";

function row(input: {
  readonly kind: SigStructureKind | null;
  readonly amount?: string;
  readonly unit?: DoseUnit;
  readonly perDay?: string;
}): StructuredSigRow {
  return {
    sigStructureKind: input.kind,
    doseAmount: input.amount === undefined ? null : new Prisma.Decimal(input.amount),
    doseUnit: input.unit ?? null,
    dosesPerDay: input.perDay === undefined ? null : new Prisma.Decimal(input.perDay),
  };
}

describe("doseInputAvailabilityFor", () => {
  it("answers NOT_CAPTURED_FOR_RECORD only for an unstructured row", () => {
    expect(doseInputAvailabilityFor(row({ kind: null }))).toBe("NOT_CAPTURED_FOR_RECORD");
  });

  it("answers AVAILABLE for every structured kind, numberless or not", () => {
    for (const kind of ["FIXED", "PRN", "RANGE", "TAPER"] as const) {
      expect(doseInputAvailabilityFor(row({ kind })), kind).toBe("AVAILABLE");
    }
  });
});

describe("doseStatementFor — per-kind mapping", () => {
  it("maps an unstructured row to null", () => {
    expect(doseStatementFor(row({ kind: null }))).toBeNull();
  });

  it("maps FIXED to a SCHEDULED statement carrying all three values", () => {
    expect(doseStatementFor(row({ kind: "FIXED", amount: "10", unit: "MG", perDay: "3" }))).toEqual(
      { amount: 10, unit: "mg", dosesPerDay: 3, basis: "SCHEDULED" }
    );
  });

  it("maps a bare PRN or TAPER to null — structured, honestly numberless", () => {
    expect(doseStatementFor(row({ kind: "PRN" }))).toBeNull();
    expect(doseStatementFor(row({ kind: "TAPER" }))).toBeNull();
  });

  it("maps a PRN without a stated ceiling to dosesPerDay 0, never an invented frequency", () => {
    // 0 is the engine's "no daily total to test" — the single-dose
    // check still runs. Any other value would screen a daily exposure
    // the prescription never stated.
    expect(doseStatementFor(row({ kind: "PRN", amount: "10", unit: "MG" }))).toEqual({
      amount: 10,
      unit: "mg",
      dosesPerDay: 0,
      basis: "MAXIMUM_PERMITTED",
    });
  });

  it("maps a PRN with a ceiling to a MAXIMUM_PERMITTED statement over the ceiling", () => {
    expect(doseStatementFor(row({ kind: "PRN", amount: "10", unit: "MG", perDay: "4" }))).toEqual({
      amount: 10,
      unit: "mg",
      dosesPerDay: 4,
      basis: "MAXIMUM_PERMITTED",
    });
  });

  it("maps RANGE to MAXIMUM_PERMITTED — the amount is the upper bound, not the regimen", () => {
    // SCHEDULED here would run the sub-therapeutic minimum against
    // the top of "1–2 tablets" and word findings as "the prescribed
    // daily total", both false statements about a range.
    expect(
      doseStatementFor(row({ kind: "RANGE", amount: "2", unit: "TABLET", perDay: "3" }))
    ).toEqual({ amount: 2, unit: "tablet", dosesPerDay: 3, basis: "MAXIMUM_PERMITTED" });
  });

  it("maps a summarized TAPER peak to MAXIMUM_PERMITTED, with 0 for an uncaptured frequency", () => {
    expect(doseStatementFor(row({ kind: "TAPER", amount: "60", unit: "MG" }))).toEqual({
      amount: 60,
      unit: "mg",
      dosesPerDay: 0,
      basis: "MAXIMUM_PERMITTED",
    });
    expect(doseStatementFor(row({ kind: "TAPER", amount: "60", unit: "MG", perDay: "1" }))).toEqual(
      { amount: 60, unit: "mg", dosesPerDay: 1, basis: "MAXIMUM_PERMITTED" }
    );
  });
});

describe("doseUnitToken", () => {
  it("lowercases the schema token into the engine's comparison spelling", () => {
    expect(doseUnitToken("MG")).toBe("mg");
    expect(doseUnitToken("TABLET")).toBe("tablet");
  });
});
