import { describe, expect, it } from "vitest";

import { classifySnapshotHealth, clampLimit } from "./list-access-review-snapshots.js";

describe("clampLimit", () => {
  it("returns the input when within bounds", () => {
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit(200)).toBe(200);
  });

  it("clamps to the upper bound", () => {
    expect(clampLimit(201)).toBe(200);
    expect(clampLimit(9_999_999)).toBe(200);
  });

  it("clamps to the lower bound when zero or negative", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
  });

  it("truncates fractional inputs", () => {
    expect(clampLimit(50.9)).toBe(50);
    expect(clampLimit(1.1)).toBe(1);
  });

  it("falls back to default for non-finite inputs", () => {
    expect(clampLimit(Number.NaN)).toBe(50);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(50);
    expect(clampLimit(Number.NEGATIVE_INFINITY)).toBe(50);
  });
});

describe("classifySnapshotHealth", () => {
  it("returns 'clean' when no elevated, inactive, or stale signals", () => {
    expect(
      classifySnapshotHealth({
        elevatedPrincipalCount: 0,
        inactivePrincipalCount: 0,
        staleAssignmentCount: 0,
      })
    ).toBe("clean");
  });

  it("returns 'elevated-only' when only elevated principals exist", () => {
    expect(
      classifySnapshotHealth({
        elevatedPrincipalCount: 3,
        inactivePrincipalCount: 0,
        staleAssignmentCount: 0,
      })
    ).toBe("elevated-only");
  });

  it("returns 'attention' when stale assignments exist (even without elevated)", () => {
    expect(
      classifySnapshotHealth({
        elevatedPrincipalCount: 0,
        inactivePrincipalCount: 0,
        staleAssignmentCount: 1,
      })
    ).toBe("attention");
  });

  it("returns 'attention' when inactive principals exist (even without stale)", () => {
    expect(
      classifySnapshotHealth({
        elevatedPrincipalCount: 0,
        inactivePrincipalCount: 2,
        staleAssignmentCount: 0,
      })
    ).toBe("attention");
  });

  it("returns 'attention' when both stale + inactive flags are set", () => {
    expect(
      classifySnapshotHealth({
        elevatedPrincipalCount: 5,
        inactivePrincipalCount: 1,
        staleAssignmentCount: 4,
      })
    ).toBe("attention");
  });

  it("treats 'attention' as the dominant signal over 'elevated-only'", () => {
    // Even with elevated principals present, a stale assignment is
    // still the higher-priority finding for the reviewer.
    expect(
      classifySnapshotHealth({
        elevatedPrincipalCount: 10,
        inactivePrincipalCount: 0,
        staleAssignmentCount: 1,
      })
    ).toBe("attention");
  });
});
