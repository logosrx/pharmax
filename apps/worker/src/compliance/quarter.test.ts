// Unit tests for the quarter math helpers. Pure functions, no DB,
// no clock. Each case pins one edge of the UTC quarter boundary.

import { describe, expect, it } from "vitest";

import {
  isFirstDayOfQuarter,
  parseQuarterLabel,
  quarterFromLabel,
  resolveCompletedQuarter,
  resolveCurrentQuarter,
} from "./quarter.js";

describe("resolveCurrentQuarter", () => {
  it("returns Q1 for Jan 1 UTC", () => {
    const period = resolveCurrentQuarter(new Date("2026-01-01T00:00:00Z"));
    expect(period.label).toBe("2026-Q1");
    expect(period.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("returns Q4 for Dec 31 UTC", () => {
    const period = resolveCurrentQuarter(new Date("2026-12-31T23:59:59Z"));
    expect(period.label).toBe("2026-Q4");
    expect(period.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("resolveCompletedQuarter", () => {
  it("returns previous-year Q4 on Jan 1 of new year", () => {
    const period = resolveCompletedQuarter(new Date("2026-01-01T03:00:00Z"));
    expect(period.label).toBe("2025-Q4");
    expect(period.start.toISOString()).toBe("2025-10-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns Q1 on Apr 1", () => {
    const period = resolveCompletedQuarter(new Date("2026-04-01T03:00:00Z"));
    expect(period.label).toBe("2026-Q1");
  });

  it("returns Q1 even mid-Q2 (we report previous, completed quarter)", () => {
    const period = resolveCompletedQuarter(new Date("2026-05-15T00:00:00Z"));
    expect(period.label).toBe("2026-Q1");
  });
});

describe("isFirstDayOfQuarter", () => {
  it.each([
    ["2026-01-01T03:00:00Z", true],
    ["2026-04-01T03:00:00Z", true],
    ["2026-07-01T03:00:00Z", true],
    ["2026-10-01T03:00:00Z", true],
    ["2026-01-02T03:00:00Z", false],
    ["2026-03-31T23:00:00Z", false],
    ["2026-02-01T03:00:00Z", false],
  ])("%s -> %s", (iso, expected) => {
    expect(isFirstDayOfQuarter(new Date(iso))).toBe(expected);
  });
});

describe("quarterFromLabel + parseQuarterLabel", () => {
  it("round-trips", () => {
    const q = quarterFromLabel(2026, 2);
    expect(q.label).toBe("2026-Q2");
    expect(parseQuarterLabel("2026-Q2").start.toISOString()).toBe(q.start.toISOString());
  });

  it("rejects invalid input", () => {
    expect(() => parseQuarterLabel("2026")).toThrow(RangeError);
    expect(() => parseQuarterLabel("2026-Q5")).toThrow(RangeError);
    expect(() => quarterFromLabel(2026, 0 as 1)).toThrow(RangeError);
    expect(() => quarterFromLabel(1900, 1)).toThrow(RangeError);
  });
});
