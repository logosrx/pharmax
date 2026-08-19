import { describe, expect, it } from "vitest";

import { PRESENCE_SLOT_MS } from "./constants.js";
import { buildPresenceSpans, deriveIdleTime, type PresenceSlotInput } from "./derive-idle.js";

const MIN = 60_000;
const T0 = new Date("2026-03-04T09:00:00.000Z").getTime();

function at(minutes: number): Date {
  return new Date(T0 + minutes * MIN);
}

/** A slot covering [slotIndex*5, slotIndex*5+5) minutes from T0. */
function slot(slotIndex: number, firstOffsetMin = 0, lastOffsetMin = 4): PresenceSlotInput {
  const start = T0 + slotIndex * PRESENCE_SLOT_MS;
  return {
    slotStartedAt: new Date(start),
    firstHeartbeatAt: new Date(start + firstOffsetMin * MIN),
    lastHeartbeatAt: new Date(start + lastOffsetMin * MIN),
  };
}

describe("buildPresenceSpans", () => {
  it("returns nothing for no slots", () => {
    expect(buildPresenceSpans([], PRESENCE_SLOT_MS)).toEqual([]);
  });

  it("stitches adjacent slots into one span", () => {
    const spans = buildPresenceSpans([slot(0), slot(1), slot(2)], PRESENCE_SLOT_MS);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startedAt.toISOString()).toBe(at(0).toISOString());
    expect(spans[0]!.endedAt.toISOString()).toBe(at(14).toISOString());
  });

  /**
   * A missing slot is the operator being GONE, not idle. Treating an
   * overnight gap as idle would make "went home" and "sat doing
   * nothing" the same number.
   */
  it("breaks the span when a slot is missing", () => {
    const spans = buildPresenceSpans([slot(0), slot(1), slot(5)], PRESENCE_SLOT_MS);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.endedAt.toISOString()).toBe(at(9).toISOString());
    expect(spans[1]!.startedAt.toISOString()).toBe(at(25).toISOString());
  });

  it("sorts unordered slots before stitching", () => {
    const spans = buildPresenceSpans([slot(2), slot(0), slot(1)], PRESENCE_SLOT_MS);
    expect(spans).toHaveLength(1);
  });
});

describe("deriveIdleTime", () => {
  it("scores an operator with no presence as fully absent, not idle", () => {
    const result = deriveIdleTime({
      slots: [],
      activityAt: [],
      idleThresholdMs: 5 * MIN,
      slotMs: PRESENCE_SLOT_MS,
    });
    expect(result).toMatchObject({ presentMs: 0, idleMs: 0, activeMs: 0 });
    expect(result.idleWindows).toEqual([]);
  });

  it("counts a whole span with no activity as one idle window", () => {
    // Present 09:00 -> 09:14, never did anything.
    const result = deriveIdleTime({
      slots: [slot(0), slot(1), slot(2)],
      activityAt: [],
      idleThresholdMs: 5 * MIN,
      slotMs: PRESENCE_SLOT_MS,
    });
    expect(result.presentMs).toBe(14 * MIN);
    expect(result.idleWindows).toHaveLength(1);
    expect(result.idleMs).toBe(14 * MIN);
    expect(result.activeMs).toBe(0);
  });

  it("does not count gaps at or below the threshold", () => {
    // Activity every 4 minutes, threshold 5 — busy the whole time.
    const result = deriveIdleTime({
      slots: [slot(0), slot(1), slot(2)],
      activityAt: [at(2), at(6), at(10), at(13)],
      idleThresholdMs: 5 * MIN,
      slotMs: PRESENCE_SLOT_MS,
    });
    expect(result.idleWindows).toEqual([]);
    expect(result.idleMs).toBe(0);
    expect(result.activeMs).toBe(14 * MIN);
  });

  it("counts a gap strictly greater than the threshold", () => {
    // One 8-minute hole between 09:03 and 09:11.
    const result = deriveIdleTime({
      slots: [slot(0), slot(1), slot(2)],
      activityAt: [at(1), at(3), at(11), at(13)],
      idleThresholdMs: 5 * MIN,
      slotMs: PRESENCE_SLOT_MS,
    });
    expect(result.idleWindows).toHaveLength(1);
    expect(result.idleWindows[0]!.durationMs).toBe(8 * MIN);
    expect(result.idleMs).toBe(8 * MIN);
    expect(result.activeMs).toBe(14 * MIN - 8 * MIN);
  });

  it("counts the stretch before the first activity of a span", () => {
    // Signed in at 09:00, first did something at 09:12.
    const result = deriveIdleTime({
      slots: [slot(0), slot(1), slot(2)],
      activityAt: [at(12), at(13)],
      idleThresholdMs: 5 * MIN,
      slotMs: PRESENCE_SLOT_MS,
    });
    expect(result.idleWindows).toHaveLength(1);
    expect(result.idleWindows[0]!.durationMs).toBe(12 * MIN);
  });

  it("counts the stretch after the last activity of a span", () => {
    const result = deriveIdleTime({
      slots: [slot(0), slot(1), slot(2)],
      activityAt: [at(1), at(2)],
      idleThresholdMs: 5 * MIN,
      slotMs: PRESENCE_SLOT_MS,
    });
    expect(result.idleWindows).toHaveLength(1);
    expect(result.idleWindows[0]!.durationMs).toBe(12 * MIN);
  });

  it("ignores activity that falls outside every presence span", () => {
    // Activity at 09:40 while presence only covers 09:00 -> 09:14.
    const result = deriveIdleTime({
      slots: [slot(0), slot(1), slot(2)],
      activityAt: [at(7), at(40)],
      idleThresholdMs: 5 * MIN,
      slotMs: PRESENCE_SLOT_MS,
    });
    expect(result.presentMs).toBe(14 * MIN);
    // 09:00->09:07 is 7m (idle) and 09:07->09:14 is 7m (idle).
    expect(result.idleWindows).toHaveLength(2);
    expect(result.idleMs).toBe(14 * MIN);
  });

  it("measures each span independently and does not bridge the gap between them", () => {
    // Two spans with a 15-minute absence between; the absence is
    // neither present nor idle.
    const result = deriveIdleTime({
      slots: [slot(0), slot(1), slot(5), slot(6)],
      activityAt: [at(1), at(26)],
      idleThresholdMs: 5 * MIN,
      slotMs: PRESENCE_SLOT_MS,
    });
    expect(result.presenceSpans).toHaveLength(2);
    // Span 1: 09:00 -> 09:09 present (9m); span 2: 09:25 -> 09:34 (9m).
    expect(result.presentMs).toBe(18 * MIN);
    // The 09:09 -> 09:25 absence never appears as an idle window.
    for (const w of result.idleWindows) {
      expect(w.durationMs).toBeLessThanOrEqual(9 * MIN);
    }
  });

  it("keeps activeMs non-negative and consistent with presentMs - idleMs", () => {
    const result = deriveIdleTime({
      slots: [slot(0), slot(1), slot(2), slot(3)],
      activityAt: [at(1), at(9), at(18)],
      idleThresholdMs: 5 * MIN,
      slotMs: PRESENCE_SLOT_MS,
    });
    expect(result.activeMs).toBe(result.presentMs - result.idleMs);
    expect(result.activeMs).toBeGreaterThanOrEqual(0);
  });
});
