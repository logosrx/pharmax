// Tests for the transcription form's schedule guidance.
//
// The point of these is that the form's controlled-substance
// affordances stay derived from `@pharmax/controlled-substances`
// rather than restated. So the assertions are about the SHAPE the
// form consumes (a cap it can put in `max`, a citation it can print)
// and about the two distinctions that are easiest to get wrong:
// Schedule V is not capped at five, and Schedule V does not carry
// § 1306.22(a)'s six-month horizon.

import { ControlledSubstanceSchedule } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import { SCHEDULE_GUIDANCE, scheduleGuidance } from "./rx-schedule-guidance.js";

describe("scheduleGuidance", () => {
  it("gives Schedule II a hard zero the form can bind to `max`", () => {
    const guidance = scheduleGuidance(ControlledSubstanceSchedule.CII);
    expect(guidance.maxRefills).toBe(0);
    expect(guidance.refillCitation).toBe("21 CFR 1306.12(a)");
    expect(guidance.refillHelp).toContain("zero is the only lawful value");
  });

  it.each([ControlledSubstanceSchedule.CIII, ControlledSubstanceSchedule.CIV])(
    "caps %s at five refills and warns about the six-month horizon",
    (schedule) => {
      const guidance = scheduleGuidance(schedule);
      expect(guidance.maxRefills).toBe(5);
      expect(guidance.refillCitation).toBe("21 CFR 1306.22(a)");
      expect(guidance.expiryHelp).toContain("six months");
    }
  );

  it("leaves Schedule V uncapped federally and off the six-month horizon", () => {
    const guidance = scheduleGuidance(ControlledSubstanceSchedule.CV);
    expect(guidance.maxRefills).toBeNull();
    expect(guidance.refillCitation).toBeNull();
    expect(guidance.expiryHelp).not.toContain("1306.22(a)");
    // Still controlled: the DEA-registration prompt and the six-month
    // default expiry both apply.
    expect(guidance.controlled).toBe(true);
    expect(guidance.requiresPrescriberDea).toBe(true);
  });

  it("asks nothing extra of a non-controlled drug", () => {
    const guidance = scheduleGuidance(ControlledSubstanceSchedule.NON_CONTROLLED);
    expect(guidance.controlled).toBe(false);
    expect(guidance.requiresPrescriberDea).toBe(false);
    expect(guidance.maxRefills).toBeNull();
    expect(guidance.expiryHelp).toContain("one-year default");
  });
});

describe("SCHEDULE_GUIDANCE", () => {
  it("covers every schedule in the enum, non-controlled first", () => {
    const offered = SCHEDULE_GUIDANCE.map((g) => g.schedule);
    expect([...offered].sort()).toEqual(Object.values(ControlledSubstanceSchedule).sort());
    expect(offered[0]).toBe(ControlledSubstanceSchedule.NON_CONTROLLED);
  });

  it("labels each schedule for an operator rather than by enum name", () => {
    expect(SCHEDULE_GUIDANCE.map((g) => g.label)).toEqual([
      "Non-controlled",
      "Schedule II",
      "Schedule III",
      "Schedule IV",
      "Schedule V",
    ]);
  });
});
