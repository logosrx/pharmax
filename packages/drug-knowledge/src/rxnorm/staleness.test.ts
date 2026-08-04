import { describe, expect, it } from "vitest";

import { assessRxnormStaleness, RXNORM_STALENESS_THRESHOLD_DAYS } from "./staleness.js";

describe("assessRxnormStaleness", () => {
  const releasedOn = new Date("2026-01-01T00:00:00.000Z");

  it("a fresh release is not stale", () => {
    const result = assessRxnormStaleness({
      releasedOn,
      now: new Date("2026-01-31T00:00:00.000Z"),
    });
    expect(result.stale).toBe(false);
    expect(result.ageDays).toBe(30);
    expect(result.thresholdDays).toBe(RXNORM_STALENESS_THRESHOLD_DAYS);
  });

  it("exactly at the threshold is still not stale; one day past is", () => {
    const atThreshold = new Date(
      releasedOn.getTime() + RXNORM_STALENESS_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
    );
    expect(assessRxnormStaleness({ releasedOn, now: atThreshold }).stale).toBe(false);
    const pastThreshold = new Date(atThreshold.getTime() + 24 * 60 * 60 * 1000);
    expect(assessRxnormStaleness({ releasedOn, now: pastThreshold }).stale).toBe(true);
  });

  it("honors a caller-supplied threshold", () => {
    const result = assessRxnormStaleness({
      releasedOn,
      now: new Date("2026-01-15T00:00:00.000Z"),
      thresholdDays: 7,
    });
    expect(result.stale).toBe(true);
    expect(result.thresholdDays).toBe(7);
  });
});
