import { describe, expect, it } from "vitest";

import { rankEntries, scoreEntry } from "./command-palette-model.js";

const ENTRIES = [
  { label: "Dashboard", group: "Workflow" },
  { label: "Typing", group: "Workflow" },
  { label: "PV1 verification", group: "Workflow" },
  { label: "Final verification", group: "Workflow" },
  { label: "Reports", group: "Finance" },
  { label: "Report history", group: "Finance" },
  { label: "Report schedules", group: "Administration" },
  { label: "Theme: Dark", group: "Preferences" },
] as const;

describe("scoreEntry", () => {
  it("returns 0 when any token fails to match", () => {
    expect(scoreEntry({ label: "Reports", group: "Finance" }, "rep zzz")).toBe(0);
  });

  it("ranks a label prefix above a mid-label substring", () => {
    const prefix = scoreEntry({ label: "Reports", group: "Finance" }, "rep");
    const substring = scoreEntry({ label: "Final verification", group: "Workflow" }, "ver");
    expect(prefix).toBeGreaterThan(substring);
  });

  it("matches every token independently (out of order)", () => {
    expect(
      scoreEntry({ label: "Report schedules", group: "Administration" }, "sch rep")
    ).toBeGreaterThan(0);
  });

  it("falls back to the group name with a low weight", () => {
    const viaGroup = scoreEntry({ label: "Dashboard", group: "Workflow" }, "workflow");
    expect(viaGroup).toBeGreaterThan(0);
    expect(viaGroup).toBeLessThan(scoreEntry({ label: "Dashboard", group: "Workflow" }, "dash"));
  });

  it("is case-insensitive on the query side", () => {
    expect(scoreEntry({ label: "PV1 verification", group: "Workflow" }, "pv1")).toBeGreaterThan(0);
  });
});

describe("rankEntries", () => {
  it("filters non-matches and puts the best match first", () => {
    const ranked = rankEntries(ENTRIES, "rep");
    expect(ranked.map((e) => e.label)).toEqual(["Reports", "Report history", "Report schedules"]);
  });

  it("finds multi-token queries across word boundaries", () => {
    const ranked = rankEntries(ENTRIES, "rep sch");
    expect(ranked.map((e) => e.label)).toEqual(["Report schedules"]);
  });

  it("returns everything-that-matches for a single letter, stably ordered within ties", () => {
    const ranked = rankEntries(ENTRIES, "verification");
    expect(ranked.map((e) => e.label)).toEqual(["PV1 verification", "Final verification"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(rankEntries(ENTRIES, "xyzzy")).toEqual([]);
  });
});
