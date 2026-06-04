import { describe, expect, it } from "vitest";

import { classifySlaStatus, msUntilSlaDeadline } from "./status.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const MIN = 60_000;

describe("classifySlaStatus", () => {
  it("returns NONE when no deadline is set", () => {
    expect(classifySlaStatus({ slaDeadlineAt: null, now: NOW })).toBe("NONE");
  });

  it("ON_TRACK when comfortably before the deadline", () => {
    const deadline = new Date(NOW.getTime() + 5 * 60 * MIN); // 5h out
    expect(classifySlaStatus({ slaDeadlineAt: deadline, now: NOW })).toBe("ON_TRACK");
  });

  it("WARNING within the warning window", () => {
    const deadline = new Date(NOW.getTime() + 10 * MIN); // 10 min out, default window 30
    expect(classifySlaStatus({ slaDeadlineAt: deadline, now: NOW })).toBe("WARNING");
  });

  it("WARNING exactly at the warning boundary (inclusive)", () => {
    const deadline = new Date(NOW.getTime() + 30 * MIN); // == default window
    expect(classifySlaStatus({ slaDeadlineAt: deadline, now: NOW })).toBe("WARNING");
  });

  it("BREACHED at or past the deadline (inclusive)", () => {
    expect(classifySlaStatus({ slaDeadlineAt: NOW, now: NOW })).toBe("BREACHED");
    expect(classifySlaStatus({ slaDeadlineAt: new Date(NOW.getTime() - MIN), now: NOW })).toBe(
      "BREACHED"
    );
  });

  it("respects a custom warning window", () => {
    const deadline = new Date(NOW.getTime() + 45 * MIN);
    expect(classifySlaStatus({ slaDeadlineAt: deadline, now: NOW })).toBe("ON_TRACK");
    expect(
      classifySlaStatus({ slaDeadlineAt: deadline, now: NOW, warningWindowMs: 60 * MIN })
    ).toBe("WARNING");
  });
});

describe("msUntilSlaDeadline", () => {
  it("null when no deadline", () => {
    expect(msUntilSlaDeadline({ slaDeadlineAt: null, now: NOW })).toBeNull();
  });

  it("positive before, negative after", () => {
    expect(msUntilSlaDeadline({ slaDeadlineAt: new Date(NOW.getTime() + MIN), now: NOW })).toBe(
      MIN
    );
    expect(msUntilSlaDeadline({ slaDeadlineAt: new Date(NOW.getTime() - MIN), now: NOW })).toBe(
      -MIN
    );
  });
});
