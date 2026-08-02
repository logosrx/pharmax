// DEA schedule vocabulary and the predicates that depend on it
// (ADR-0037 commitment 1).
//
// Pure: no clock, no I/O, no exceptions. The Prisma enum is the single
// source of truth for the vocabulary; this module adds the semantics
// Part 1306 attaches to each value.

import { ControlledSubstanceSchedule } from "@pharmax/database";

/**
 * Schedules that are controlled substances. `NON_CONTROLLED` is the
 * only excluded member.
 *
 * Schedule I has no member because Schedule I substances cannot be
 * prescribed (21 CFR 1308.11) — see the enum comment in schema.prisma.
 */
export const CONTROLLED_SCHEDULES: ReadonlySet<ControlledSubstanceSchedule> = Object.freeze(
  new Set([
    ControlledSubstanceSchedule.CII,
    ControlledSubstanceSchedule.CIII,
    ControlledSubstanceSchedule.CIV,
    ControlledSubstanceSchedule.CV,
  ])
) as ReadonlySet<ControlledSubstanceSchedule>;

/** True when the schedule denotes a DEA controlled substance. */
export function isControlled(schedule: ControlledSubstanceSchedule): boolean {
  return CONTROLLED_SCHEDULES.has(schedule);
}

/**
 * True when dispensing requires the prescriber to hold a DEA
 * registration. Every controlled schedule does; nothing else does.
 */
export function requiresPrescriberDeaRegistration(schedule: ControlledSubstanceSchedule): boolean {
  return isControlled(schedule);
}

/**
 * Federal cap on the number of refills a prescription may AUTHORIZE.
 *
 *   - Schedule II — 0. "The refilling of a prescription for a
 *     controlled substance listed in Schedule II is prohibited."
 *     (21 CFR 1306.12(a))
 *   - Schedule III / IV — 5. "No prescription for a controlled
 *     substance listed in Schedule III or IV authorized to be refilled
 *     may be refilled more than five times." (21 CFR 1306.22(a))
 *   - Schedule V — no federal cap. § 1306.22(a) names only Schedules
 *     III and IV; Schedule V is deliberately absent from it. Returns
 *     `null`, NOT 5. States frequently impose their own cap — that is a
 *     state-overlay concern, not a federal one, and must not be
 *     hard-coded here.
 *   - Non-controlled — no cap from this part.
 */
export function federalRefillCap(schedule: ControlledSubstanceSchedule): number | null {
  switch (schedule) {
    case ControlledSubstanceSchedule.CII:
      return 0;
    case ControlledSubstanceSchedule.CIII:
    case ControlledSubstanceSchedule.CIV:
      return 5;
    case ControlledSubstanceSchedule.CV:
    case ControlledSubstanceSchedule.NON_CONTROLLED:
      return null;
    default: {
      const exhaustive: never = schedule;
      return exhaustive;
    }
  }
}

/**
 * True when 21 CFR 1306.22(a)'s six-month fill/refill horizon applies
 * to an ordinary (non-partial) fill.
 *
 * Schedules III and IV only. Schedule V is excluded on purpose: the
 * six-month bar in § 1306.22(a) names III and IV, and the separate
 * six-month bar in § 1306.23(c) applies to Schedule V only in the
 * PARTIAL-fill case. Lumping CV in with CIII/CIV here is the most
 * common way to get this wrong.
 */
export function hasSixMonthRefillHorizon(schedule: ControlledSubstanceSchedule): boolean {
  return (
    schedule === ControlledSubstanceSchedule.CIII || schedule === ControlledSubstanceSchedule.CIV
  );
}

/**
 * True when 21 CFR 1306.23's partial-fill regime governs — Schedules
 * III, IV, and V. Schedule II partial fills are governed by the
 * materially different § 1306.13 instead.
 */
export function hasScheduleThreeToFivePartialFillRegime(
  schedule: ControlledSubstanceSchedule
): boolean {
  return (
    schedule === ControlledSubstanceSchedule.CIII ||
    schedule === ControlledSubstanceSchedule.CIV ||
    schedule === ControlledSubstanceSchedule.CV
  );
}
