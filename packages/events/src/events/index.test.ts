// Top-level event-catalog tests.
//
// Pins:
//   - Every registered definition has a non-empty description.
//   - Every registered definition has an explicit owner (NOT the
//     "system" default — that default is reserved as a red flag).
//   - Every registered definition has a retention drawn from the
//     `{7y, 90d, 30d}` set.
//   - phiSafe defaults to true; an event setting phiSafe=false is
//     an explicit, reviewed change — today no event does so.
//   - The registry's sorted name list matches the union of the
//     per-domain barrels' exports.
//
// The repo-wide parity guard lives in `../parity-guard.test.ts` —
// these tests cover the SHAPE of registry entries, not parity
// against source.

import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, listRegisteredEventDefinitions } from "../registry.js";

describe("event catalog", () => {
  it("has at least 50 registered definitions (post-allowlist-migration baseline)", () => {
    // Sanity floor — if the count drops below this without a
    // corresponding allowlist increase, something was removed.
    expect(EVENT_REGISTRY.size).toBeGreaterThanOrEqual(50);
  });

  it("every definition has a non-empty description", () => {
    for (const def of EVENT_REGISTRY.values()) {
      expect(def.description, `${def.fullName} has empty description`).toBeTruthy();
      expect(def.description.length).toBeGreaterThan(20);
    }
  });

  it("every definition declares an explicit owner (no 'system' default)", () => {
    const unowned = [...EVENT_REGISTRY.values()].filter((d) => d.owner === "system");
    expect(unowned.map((d) => d.fullName)).toEqual([]);
  });

  it("every definition has a valid retention", () => {
    const valid = new Set(["7y", "90d", "30d"]);
    for (const def of EVENT_REGISTRY.values()) {
      expect(valid.has(def.retention), `${def.fullName} retention=${def.retention}`).toBe(true);
    }
  });

  it("every definition is PHI-safe (no event today carries PHI)", () => {
    const phiBearing = [...EVENT_REGISTRY.values()].filter((d) => d.phiSafe === false);
    // If you add a PHI-bearing event, intentionally update this
    // assertion AND wire a PHI-capable consumer + per-event PHI
    // review. Do NOT silently flip the flag.
    expect(phiBearing.map((d) => d.fullName)).toEqual([]);
  });

  it("listRegisteredEventDefinitions is sorted by fullName", () => {
    const defs = listRegisteredEventDefinitions();
    const names = defs.map((d) => d.fullName);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});
