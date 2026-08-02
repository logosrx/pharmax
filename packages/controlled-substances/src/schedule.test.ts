import { ControlledSubstanceSchedule } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import {
  CONTROLLED_SCHEDULES,
  federalRefillCap,
  hasScheduleThreeToFivePartialFillRegime,
  hasSixMonthRefillHorizon,
  isControlled,
  requiresPrescriberDeaRegistration,
} from "./index.js";

const ALL_SCHEDULES = Object.values(ControlledSubstanceSchedule);

describe("schedule vocabulary", () => {
  it("has no Schedule I member — Schedule I substances cannot be prescribed", () => {
    // 21 CFR 1308.11. Guards against a well-meaning future PR adding
    // CI "for completeness".
    expect(ALL_SCHEDULES).not.toContain("CI");
    expect(ALL_SCHEDULES).toHaveLength(5);
  });

  it("classifies every schedule except NON_CONTROLLED as controlled", () => {
    for (const schedule of ALL_SCHEDULES) {
      const expected = schedule !== ControlledSubstanceSchedule.NON_CONTROLLED;
      expect(isControlled(schedule)).toBe(expected);
      expect(CONTROLLED_SCHEDULES.has(schedule)).toBe(expected);
      expect(requiresPrescriberDeaRegistration(schedule)).toBe(expected);
    }
  });
});

describe("federalRefillCap", () => {
  it.each([
    [ControlledSubstanceSchedule.CII, 0],
    [ControlledSubstanceSchedule.CIII, 5],
    [ControlledSubstanceSchedule.CIV, 5],
    [ControlledSubstanceSchedule.CV, null],
    [ControlledSubstanceSchedule.NON_CONTROLLED, null],
  ])("returns %s -> %s", (schedule, expected) => {
    expect(federalRefillCap(schedule)).toBe(expected);
  });

  it("returns null (not 5) for Schedule V", () => {
    // 1306.22(a) names Schedules III and IV only. Returning 5 here
    // would invent a federal cap that does not exist.
    expect(federalRefillCap(ControlledSubstanceSchedule.CV)).toBeNull();
  });
});

describe("six-month horizon vs partial-fill regime", () => {
  it("applies the 1306.22(a) ordinary horizon to III and IV only", () => {
    expect(hasSixMonthRefillHorizon(ControlledSubstanceSchedule.CIII)).toBe(true);
    expect(hasSixMonthRefillHorizon(ControlledSubstanceSchedule.CIV)).toBe(true);
    expect(hasSixMonthRefillHorizon(ControlledSubstanceSchedule.CV)).toBe(false);
    expect(hasSixMonthRefillHorizon(ControlledSubstanceSchedule.CII)).toBe(false);
  });

  it("applies the 1306.23 partial-fill regime to III, IV and V", () => {
    expect(hasScheduleThreeToFivePartialFillRegime(ControlledSubstanceSchedule.CIII)).toBe(true);
    expect(hasScheduleThreeToFivePartialFillRegime(ControlledSubstanceSchedule.CIV)).toBe(true);
    expect(hasScheduleThreeToFivePartialFillRegime(ControlledSubstanceSchedule.CV)).toBe(true);
    // Schedule II partial fills are governed by 1306.13 instead.
    expect(hasScheduleThreeToFivePartialFillRegime(ControlledSubstanceSchedule.CII)).toBe(false);
  });
});
