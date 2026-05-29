// cron-parser wrapper tests.

import { describe, expect, it } from "vitest";

import { computeNextRun, validateCron } from "./cron.js";

const NOW = new Date("2026-05-28T12:00:00.000Z");

describe("validateCron — happy path", () => {
  it("accepts a standard 5-field expression and returns the next fire", () => {
    const r = validateCron({
      expression: "0 9 * * 1", // 9am every Monday
      timezone: "UTC",
      from: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Next Monday 9am UTC after 2026-05-28 (Thu) is 2026-06-01 09:00:00Z
      expect(r.nextRunAt.toISOString()).toBe("2026-06-01T09:00:00.000Z");
    }
  });

  it("respects the IANA timezone for evaluation", () => {
    // 0 9 * * 1 in America/New_York means 9am Mon NYC =
    // 13:00 (or 14:00 in EST) UTC. 2026-06-01 is EDT (UTC-4),
    // so 9am NYC = 13:00 UTC.
    const r = validateCron({
      expression: "0 9 * * 1",
      timezone: "America/New_York",
      from: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nextRunAt.toISOString()).toBe("2026-06-01T13:00:00.000Z");
    }
  });
});

describe("validateCron — guards", () => {
  it("rejects an empty expression", () => {
    const r = validateCron({ expression: "  ", timezone: "UTC" });
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed expression", () => {
    const r = validateCron({ expression: "this is not cron", timezone: "UTC" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it("rejects a malformed timezone", () => {
    const r = validateCron({
      expression: "0 9 * * 1",
      timezone: "Not/A_Real_Zone",
    });
    expect(r.ok).toBe(false);
  });
});

describe("computeNextRun", () => {
  it("advances past the given anchor", () => {
    const next = computeNextRun({
      expression: "0 9 * * 1",
      timezone: "UTC",
      from: new Date("2026-06-01T09:00:00.000Z"), // exactly Mon 9am
    });
    // Must produce the NEXT Mon 9am, not this one
    expect(next.toISOString()).toBe("2026-06-08T09:00:00.000Z");
  });
});
