// DOB normalization tests.
//
// The end-to-end blind-index computation goes through `@pharmax/crypto`
// and needs configuration; that test path lives in the crypto package.
// What this file pins is the DOB string-shape normalization: it's the
// piece that's specific to the patient domain and the most likely
// source of an "intake form posted YYYY-MM-DD; search posted
// YYYY/MM/DD" mismatch.

import { describe, expect, it } from "vitest";

import { normalizeDobForBlindIndex, normalizeDobYearMonthForBlindIndex } from "./blind-indexes.js";

describe("normalizeDobForBlindIndex", () => {
  it.each([
    ["1990-04-15", "19900415"],
    ["2000-01-01", "20000101"],
    ["1899-12-31", null], // year < 1900
    ["2201-01-01", null], // year > 2200
    ["2024-13-01", null], // month 13
    ["2024-00-01", null], // month 0
    ["2024-04-32", null], // day 32
    ["2024-04-00", null], // day 0
    ["24-04-15", null], // 2-digit year
    ["2024/04/15", null], // wrong separator
    ["2024-4-15", null], // unpadded month
    ["", null],
    ["not-a-date", null],
  ])("normalizeDobForBlindIndex(%p) === %p", (input, expected) => {
    expect(normalizeDobForBlindIndex(input)).toBe(expected);
  });
});

describe("normalizeDobYearMonthForBlindIndex", () => {
  it.each([
    ["1990-04", "199004"],
    ["2024-12", "202412"],
    ["1899-04", null], // year < 1900
    ["2201-04", null], // year > 2200
    ["2024-13", null], // month 13
    ["2024-00", null], // month 0
    ["2024-4", null], // unpadded month
    ["24-04", null], // 2-digit year
    ["2024-04-15", null], // full date instead of YYYY-MM
    ["", null],
  ])("normalizeDobYearMonthForBlindIndex(%p) === %p", (input, expected) => {
    expect(normalizeDobYearMonthForBlindIndex(input)).toBe(expected);
  });
});
