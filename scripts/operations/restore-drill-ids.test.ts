// scripts/operations/restore-drill-ids.test.ts
//
// Pure-helper coverage for the restore-drill CLI's deterministic id
// + bounds-check logic. Lives alongside the helper rather than under
// `__tests__/` because the CI runs `pnpm vitest run` from the repo
// root and picks up `scripts/**/*.test.ts` already (the linter +
// schema + commands checks all use the same pattern).

import { describe, expect, it } from "vitest";

import {
  assertValidDbClusterId,
  currentQuarterLabel,
  drillClusterId,
  drillInstanceId,
  InvalidDrillInputError,
  parseRestoreTime,
  utcDateStamp,
} from "./restore-drill-ids.js";

describe("currentQuarterLabel", () => {
  it.each([
    { iso: "2026-01-15T12:00:00Z", expected: "2026-Q1" },
    { iso: "2026-03-31T23:59:59Z", expected: "2026-Q1" },
    { iso: "2026-04-01T00:00:00Z", expected: "2026-Q2" },
    { iso: "2026-06-30T23:59:59Z", expected: "2026-Q2" },
    { iso: "2026-07-01T00:00:00Z", expected: "2026-Q3" },
    { iso: "2026-12-31T23:59:59Z", expected: "2026-Q4" },
    { iso: "2027-01-01T00:00:00Z", expected: "2027-Q1" },
  ])('"$iso" → $expected', ({ iso, expected }) => {
    expect(currentQuarterLabel(new Date(iso))).toBe(expected);
  });
});

describe("utcDateStamp", () => {
  it.each([
    { iso: "2026-06-04T19:30:00Z", expected: "20260604" },
    { iso: "2026-01-01T00:00:00Z", expected: "20260101" },
    { iso: "2026-12-31T23:59:59Z", expected: "20261231" },
    // Local-time edge: the date is computed from UTC components, so
    // a US/Pacific operator running the drill at 5pm PDT on the 4th
    // (which is past midnight UTC on the 5th) gets the 5th. That's
    // the right thing — Aurora's clock is UTC.
    { iso: "2026-06-05T00:30:00Z", expected: "20260605" },
  ])('"$iso" → $expected', ({ iso, expected }) => {
    expect(utcDateStamp(new Date(iso))).toBe(expected);
  });
});

describe("assertValidDbClusterId", () => {
  it.each([
    "pharmax-prod-use1-aurora",
    "pharmax-prod-use1-aurora-drill-20260604",
    "a",
    "abc123",
    "a-b-c-d",
    "pharmax01",
  ])('accepts "%s"', (id) => {
    expect(() => {
      assertValidDbClusterId(id);
    }).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["starts-with-digit", "1abc"],
    ["starts-with-hyphen", "-abc"],
    ["uppercase", "Pharmax"],
    ["underscore", "pharmax_prod"],
    ["dot", "pharmax.prod"],
    ["consecutive-hyphens", "pharmax--prod"],
    ["trailing-hyphen", "pharmax-prod-"],
    ["too-long (64 chars)", `a${"b".repeat(63)}`],
  ])("rejects %s", (_label, id) => {
    expect(() => {
      assertValidDbClusterId(id);
    }).toThrow(InvalidDrillInputError);
  });
});

describe("drillClusterId", () => {
  it("computes the deterministic drill cluster id from source + date", () => {
    const id = drillClusterId({
      sourceClusterId: "pharmax-prod-use1-aurora",
      now: new Date("2026-06-04T19:30:00Z"),
    });
    expect(id).toBe("pharmax-prod-use1-aurora-drill-20260604");
  });

  it("is idempotent for the same inputs", () => {
    const inputs = {
      sourceClusterId: "pharmax-prod-use1-aurora",
      now: new Date("2026-06-04T19:30:00Z"),
    };
    expect(drillClusterId(inputs)).toBe(drillClusterId(inputs));
  });

  it("rejects an already-invalid source cluster id", () => {
    expect(() => {
      drillClusterId({
        sourceClusterId: "Pharmax-Prod",
        now: new Date("2026-06-04T19:30:00Z"),
      });
    }).toThrow(InvalidDrillInputError);
  });

  it("rejects a source id that would overflow the 63-char cluster-id limit after suffix", () => {
    // Source is 50 chars; -drill-YYYYMMDD adds 15 → 65 total, over the 63 cap.
    const longSource = `a${"b".repeat(49)}`;
    expect(() => {
      drillClusterId({
        sourceClusterId: longSource,
        now: new Date("2026-06-04T19:30:00Z"),
      });
    }).toThrow(InvalidDrillInputError);
  });
});

describe("drillInstanceId", () => {
  it("appends -0 to the drill cluster id", () => {
    const id = drillInstanceId({
      sourceClusterId: "pharmax-prod-use1-aurora",
      now: new Date("2026-06-04T19:30:00Z"),
    });
    expect(id).toBe("pharmax-prod-use1-aurora-drill-20260604-0");
  });
});

describe("parseRestoreTime", () => {
  const NOW = new Date("2026-06-04T19:30:00Z");

  it("accepts an ISO 8601 instant inside the retention window", () => {
    const parsed = parseRestoreTime({
      raw: "2026-06-04T12:00:00Z",
      now: NOW,
      retentionDays: 35,
    });
    expect(parsed.toISOString()).toBe("2026-06-04T12:00:00.000Z");
  });

  it("accepts millisecond-precision input", () => {
    const parsed = parseRestoreTime({
      raw: "2026-06-04T12:00:00.123Z",
      now: NOW,
      retentionDays: 35,
    });
    expect(parsed.toISOString()).toBe("2026-06-04T12:00:00.123Z");
  });

  it.each([
    ["naive datetime", "2026-06-04T12:00:00"],
    ["with timezone offset (not Z)", "2026-06-04T12:00:00+00:00"],
    ["date only", "2026-06-04"],
    ["empty", ""],
    ["nonsense", "yesterday"],
  ])("rejects %s", (_label, raw) => {
    expect(() => {
      parseRestoreTime({ raw, now: NOW, retentionDays: 35 });
    }).toThrow(InvalidDrillInputError);
  });

  it("rejects a future restore time", () => {
    expect(() => {
      parseRestoreTime({
        raw: "2026-06-05T00:00:00Z",
        now: NOW,
        retentionDays: 35,
      });
    }).toThrow(/must be in the past/);
  });

  it("rejects equal-to-now (must be strictly past)", () => {
    expect(() => {
      parseRestoreTime({
        raw: "2026-06-04T19:30:00Z",
        now: NOW,
        retentionDays: 35,
      });
    }).toThrow(/must be in the past/);
  });

  it("rejects a restore time older than the retention window", () => {
    expect(() => {
      // 36 days before NOW; retention is 35 days.
      parseRestoreTime({
        raw: "2026-04-29T19:30:00Z",
        now: NOW,
        retentionDays: 35,
      });
    }).toThrow(/older than the retention window/);
  });

  it.each([
    { retentionDays: 0 },
    { retentionDays: -1 },
    { retentionDays: 1.5 },
    { retentionDays: Number.NaN },
  ])("rejects invalid retentionDays=$retentionDays", ({ retentionDays }) => {
    expect(() => {
      parseRestoreTime({
        raw: "2026-06-04T12:00:00Z",
        now: NOW,
        retentionDays,
      });
    }).toThrow(InvalidDrillInputError);
  });
});
