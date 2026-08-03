// Per-schedule guidance for the transcription form.
//
// The transcription screen wants to tell a technician that a Schedule
// II drug can only ever authorize zero refills BEFORE they submit and
// lose the round trip. The rule itself must not be restated in the
// browser: `@pharmax/controlled-substances` owns Part 1306, the
// command applies it, and the backend stays the source of truth.
//
// So the rule is evaluated HERE, on the server, and shipped to the
// client form as plain data. The form renders whatever the cap says
// and has no opinion of its own — if the DEA reschedules a substance
// and the package changes, the form changes with it and nothing in
// `rx-transcription-form.tsx` needs touching.
//
// Pure and PHI-free: schedule vocabulary in, sentences out.

import "server-only";

import {
  federalRefillCap,
  hasSixMonthRefillHorizon,
  isControlled,
  requiresPrescriberDeaRegistration,
} from "@pharmax/controlled-substances";
import { ControlledSubstanceSchedule } from "@pharmax/database";

export interface ScheduleGuidance {
  readonly schedule: ControlledSubstanceSchedule;
  /** Human label — "Schedule II", not "CII". */
  readonly label: string;
  readonly controlled: boolean;
  /** Federal ceiling on authorized refills; null where Part 1306 sets none. */
  readonly maxRefills: number | null;
  /** What the operator may enter in the refills field, and why. */
  readonly refillHelp: string;
  /** Named only where a federal rule caps the refills. */
  readonly refillCitation: string | null;
  /** What happens if the expiry field is left blank, and any hard ceiling. */
  readonly expiryHelp: string;
  readonly requiresPrescriberDea: boolean;
}

function scheduleLabel(schedule: ControlledSubstanceSchedule): string {
  switch (schedule) {
    case ControlledSubstanceSchedule.CII:
      return "Schedule II";
    case ControlledSubstanceSchedule.CIII:
      return "Schedule III";
    case ControlledSubstanceSchedule.CIV:
      return "Schedule IV";
    case ControlledSubstanceSchedule.CV:
      return "Schedule V";
    case ControlledSubstanceSchedule.NON_CONTROLLED:
      return "Non-controlled";
    default: {
      const exhaustive: never = schedule;
      return exhaustive;
    }
  }
}

function refillHelp(schedule: ControlledSubstanceSchedule, cap: number | null): string {
  if (cap === 0) {
    return "Schedule II authorizes no refills — zero is the only lawful value.";
  }
  if (cap !== null) {
    return `${scheduleLabel(schedule)} may authorize at most ${cap} refills.`;
  }
  if (isControlled(schedule)) {
    // § 1306.22(a) names Schedules III and IV only; CV's absence from
    // it is deliberate, and states routinely fill the gap themselves.
    return "No federal refill cap on Schedule V. Your state may impose one — enter what the prescriber wrote.";
  }
  return "Part 1306 sets no refill cap for a non-controlled drug.";
}

function refillCitation(schedule: ControlledSubstanceSchedule): string | null {
  if (schedule === ControlledSubstanceSchedule.CII) return "21 CFR 1306.12(a)";
  if (hasSixMonthRefillHorizon(schedule)) return "21 CFR 1306.22(a)";
  return null;
}

function expiryHelp(schedule: ControlledSubstanceSchedule): string {
  if (hasSixMonthRefillHorizon(schedule)) {
    return "Leave blank for the six-month default. A later date is refused: this schedule is not fillable more than six months after it was written (21 CFR 1306.22(a)).";
  }
  if (isControlled(schedule)) {
    return "Leave blank for the six-month default Pharmax applies to controlled substances.";
  }
  return "Leave blank for the one-year default.";
}

export function scheduleGuidance(schedule: ControlledSubstanceSchedule): ScheduleGuidance {
  const cap = federalRefillCap(schedule);
  return Object.freeze({
    schedule,
    label: scheduleLabel(schedule),
    controlled: isControlled(schedule),
    maxRefills: cap,
    refillHelp: refillHelp(schedule, cap),
    refillCitation: refillCitation(schedule),
    expiryHelp: expiryHelp(schedule),
    requiresPrescriberDea: requiresPrescriberDeaRegistration(schedule),
  });
}

/**
 * Guidance for every schedule, in the order the form's picker offers
 * them. Non-controlled leads because it is the common case; the
 * controlled schedules follow in DEA order.
 */
export const SCHEDULE_GUIDANCE: ReadonlyArray<ScheduleGuidance> = Object.freeze(
  [
    ControlledSubstanceSchedule.NON_CONTROLLED,
    ControlledSubstanceSchedule.CII,
    ControlledSubstanceSchedule.CIII,
    ControlledSubstanceSchedule.CIV,
    ControlledSubstanceSchedule.CV,
  ].map(scheduleGuidance)
);
