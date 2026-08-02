// Part 1306 dispensing rules for controlled substances
// (ADR-0037 commitment 1).
//
// TOTAL and PURE, in the same spirit as `@pharmax/workflow`'s
// `applyTransition`: no clock (the evaluation instant is an input), no
// I/O, no exceptions. Every evaluation returns a value, so the same
// function is reusable from a command handler, a UI affordance check,
// and a replay over `command_log`.
//
// Every rule cites the CFR paragraph it implements. When a rule looks
// asymmetric across schedules, that asymmetry is in the regulation —
// see the Schedule V notes below, which are the most common source of
// incorrect implementations.
//
// SCOPE: federal law only. States routinely impose stricter caps
// (shorter horizons, refill limits on Schedule V). Those belong in a
// state-overlay layer, not here; silently folding them in would make
// this module wrong for the jurisdictions that do not impose them.

import {
  ControlledSubstancePartialFillBasis,
  ControlledSubstanceSchedule,
} from "@pharmax/database";

import {
  federalRefillCap,
  hasScheduleThreeToFivePartialFillRegime,
  hasSixMonthRefillHorizon,
  isControlled,
} from "./schedule.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Which partial-fill regime a dispensing is being made under. `null`
 * means an ordinary complete fill.
 *
 * The Schedule II bases are materially different from one another —
 * they carry different completion windows — so they are distinct
 * members rather than one `PARTIAL` flag.
 */
export const PARTIAL_FILL_BASES = Object.freeze([
  /** 21 CFR 1306.13(a) — pharmacist cannot supply the full quantity. */
  ControlledSubstancePartialFillBasis.PHARMACIST_SUPPLY_SHORTFALL,
  /** 21 CFR 1306.13(b) — requested by the patient or the prescriber. */
  ControlledSubstancePartialFillBasis.PATIENT_OR_PRESCRIBER_REQUEST,
  /** 21 CFR 1306.13(c) — LTCF resident or documented terminal illness. */
  ControlledSubstancePartialFillBasis.LTCF_OR_TERMINALLY_ILL,
  /** 21 CFR 1306.23 — the Schedule III/IV/V partial-fill regime. */
  ControlledSubstancePartialFillBasis.SCHEDULE_III_TO_V,
] as const);

/**
 * Aliased to the Prisma enum rather than redeclared, so the persisted
 * vocabulary and the vocabulary the rules reason over cannot drift.
 */
export type PartialFillBasis = ControlledSubstancePartialFillBasis;

export const DISPENSING_VIOLATION_CODES = Object.freeze([
  "CS_EARLIEST_FILL_DATE_NOT_REACHED",
  "CS_SCHEDULE_II_REFILL_PROHIBITED",
  "CS_REFILL_LIMIT_EXCEEDED",
  "CS_SIX_MONTH_HORIZON_ELAPSED",
  "CS_QUANTITY_EXCEEDS_AUTHORIZED",
  "CS_SCHEDULE_II_PARTIAL_FILL_WINDOW_ELAPSED",
  "CS_PARTIAL_FILL_BASIS_INVALID_FOR_SCHEDULE",
] as const);

export type DispensingViolationCode = (typeof DISPENSING_VIOLATION_CODES)[number];

export interface DispensingViolation {
  readonly code: DispensingViolationCode;
  /** Operator-facing explanation. Never contains PHI. */
  readonly reason: string;
  /** The CFR paragraph this rule implements, for audit metadata. */
  readonly citation: string;
}

/** The prescription facts Part 1306 evaluation depends on. */
export interface ControlledPrescriptionSnapshot {
  readonly schedule: ControlledSubstanceSchedule;
  /** Date the prescription was issued (date-only semantics, UTC). */
  readonly originalDateWritten: Date;
  readonly refillsAuthorized: number;
  readonly quantityAuthorized: number;
  /** Prescriber's "do not fill before" instruction, or null. */
  readonly earliestFillDate: Date | null;
}

export interface DispensingRequest {
  readonly prescription: ControlledPrescriptionSnapshot;
  /**
   * Ordinal of the FILL this dispensing belongs to: 1 = the original
   * fill, 2 = the first refill, and so on.
   *
   * A partial-fill continuation does NOT advance this — it completes
   * the quantity authorized for the fill already in progress. That
   * distinction is the whole reason this is a fill ordinal rather than
   * a count of dispensing events: § 1306.12(a) prohibits *refilling* a
   * Schedule II prescription, while § 1306.13 expressly permits
   * supplying the remainder of a partially filled one.
   */
  readonly fillNumber: number;
  /**
   * Quantity already supplied within THIS fill by earlier partial
   * fills. Zero for the first dispensing of any fill.
   *
   * Scoped to the fill, not the prescription lifetime, because
   * `quantityAuthorized` is a PER-FILL quantity. A Schedule III
   * prescription for 30 tablets with 5 refills authorizes 30 per fill,
   * not 30 in total, so a lifetime running sum would flag refill 1 as
   * exceeding the authorized quantity.
   */
  readonly quantityDispensedInFill: number;
  /** Quantity this dispensing would supply. */
  readonly quantityToFill: number;
  /**
   * Instant of the first partial fill OF THIS FILL — starts the
   * § 1306.13(a) 72-hour clock.
   */
  readonly firstPartialFillAt: Date | null;
  readonly partialFillBasis: PartialFillBasis | null;
  /** Evaluation instant. Injected so the function stays pure. */
  readonly asOf: Date;
}

export type DispensingEvaluation =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: ReadonlyArray<DispensingViolation> };

// ---------------------------------------------------------------------------
// Date helpers — UTC calendar arithmetic
// ---------------------------------------------------------------------------

/** Midnight UTC on the calendar day containing `d`. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** `d` plus `n` calendar days, at midnight UTC. */
export function addUtcDays(d: Date, n: number): Date {
  const base = startOfUtcDay(d);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + n));
}

/**
 * `d` plus `n` calendar months, at midnight UTC, clamped to the last
 * day of the target month.
 *
 * Clamping matters: 31 August + 6 months has no 31 February to land
 * on. Date's rollover would silently produce 3 March, extending the
 * lawful window by two days. We clamp to 28/29 February instead, which
 * is the conservative reading — the window closes no later than the
 * calendar suggests.
 */
export function addUtcCalendarMonths(d: Date, n: number): Date {
  const base = startOfUtcDay(d);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + n;
  const day = base.getUTCDate();
  // Day 0 of the following month is the last day of the target month.
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDayOfTargetMonth)));
}

const HOURS_72_MS = 72 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Authorization-time validation (what a prescription may AUTHORIZE)
// ---------------------------------------------------------------------------

export interface AuthorizationInput {
  readonly schedule: ControlledSubstanceSchedule;
  readonly refillsAuthorized: number;
}

/**
 * Validate the refill count a prescription may lawfully authorize.
 * Evaluated when a prescription is created or amended — separate from
 * dispensing, because an over-authorized prescription is defective at
 * issuance, not merely unfillable later.
 */
export function validateControlledPrescriptionAuthorization(
  input: AuthorizationInput
): DispensingEvaluation {
  const cap = federalRefillCap(input.schedule);
  if (cap === null || input.refillsAuthorized <= cap) {
    return { ok: true };
  }

  if (input.schedule === ControlledSubstanceSchedule.CII) {
    return {
      ok: false,
      violations: [
        {
          code: "CS_SCHEDULE_II_REFILL_PROHIBITED",
          reason: `A Schedule II prescription may not authorize refills (authorized: ${input.refillsAuthorized}).`,
          citation: "21 CFR 1306.12(a)",
        },
      ],
    };
  }

  return {
    ok: false,
    violations: [
      {
        code: "CS_REFILL_LIMIT_EXCEEDED",
        reason: `A ${input.schedule} prescription may authorize at most ${cap} refills (authorized: ${input.refillsAuthorized}).`,
        citation: "21 CFR 1306.22(a)",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Dispensing-time evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a single dispensing is permitted under Part 1306.
 *
 * Returns EVERY violation rather than short-circuiting, so an operator
 * sees the complete reason a fill is blocked instead of discovering
 * one problem per attempt.
 *
 * Non-controlled prescriptions are always `ok` here — this module has
 * no opinion on them. Ordinary expiry and refill accounting for
 * non-controlled drugs live in the prescription lifecycle, not in the
 * DEA rules.
 */
export function evaluateDispensing(request: DispensingRequest): DispensingEvaluation {
  const { prescription: rx } = request;

  if (!isControlled(rx.schedule)) {
    return { ok: true };
  }

  const violations: DispensingViolation[] = [];
  const asOfDay = startOfUtcDay(request.asOf);
  const isPartial = request.partialFillBasis !== null;

  // --- 21 CFR 1306.14(e) — prescriber's "do not fill before" date. ---
  if (rx.earliestFillDate !== null && asOfDay < startOfUtcDay(rx.earliestFillDate)) {
    violations.push({
      code: "CS_EARLIEST_FILL_DATE_NOT_REACHED",
      reason: "The prescriber instructed that this prescription not be filled before a later date.",
      citation: "21 CFR 1306.14(e)",
    });
  }

  // --- Partial-fill basis must match the schedule's regime. ---
  // Schedule II partial fills are governed by § 1306.13; Schedules
  // III–V by § 1306.23. Using one regime's basis under the other's
  // schedule means the completion window would be computed from the
  // wrong rule, so it is rejected rather than coerced.
  if (request.partialFillBasis !== null) {
    const isScheduleTwoBasis = request.partialFillBasis !== "SCHEDULE_III_TO_V";
    const scheduleIsTwo = rx.schedule === ControlledSubstanceSchedule.CII;
    if (isScheduleTwoBasis !== scheduleIsTwo) {
      violations.push({
        code: "CS_PARTIAL_FILL_BASIS_INVALID_FOR_SCHEDULE",
        reason: `Partial-fill basis ${request.partialFillBasis} does not apply to a ${rx.schedule} prescription.`,
        citation: "21 CFR 1306.13 / 21 CFR 1306.23",
      });
    }
  }

  // --- 21 CFR 1306.12(a) — no refilling a Schedule II prescription. ---
  // Keyed on the FILL ordinal, not on how many dispensing events have
  // occurred: a partial-fill continuation stays on fill 1 and is
  // lawful under § 1306.13, whereas anything that advances to fill 2
  // is a refill and is prohibited outright.
  if (rx.schedule === ControlledSubstanceSchedule.CII && request.fillNumber > 1) {
    violations.push({
      code: "CS_SCHEDULE_II_REFILL_PROHIBITED",
      reason:
        "A Schedule II prescription cannot be refilled; a further dispensing is permitted only to complete an authorized partial fill.",
      citation: "21 CFR 1306.12(a)",
    });
  }

  // --- 21 CFR 1306.22(a) — refill count for Schedules III and IV. ---
  // Fill 1 is the original fill; fill N is refill N-1. A partial-fill
  // continuation does not advance `fillNumber`, so it cannot consume
  // a refill.
  if (hasSixMonthRefillHorizon(rx.schedule) && request.fillNumber > 1) {
    const refillNumber = request.fillNumber - 1;
    const cap = federalRefillCap(rx.schedule);
    if (cap !== null && refillNumber > cap) {
      violations.push({
        code: "CS_REFILL_LIMIT_EXCEEDED",
        reason: `A ${rx.schedule} prescription may not be refilled more than ${cap} times (this would be refill ${refillNumber}).`,
        citation: "21 CFR 1306.22(a)",
      });
    } else if (refillNumber > rx.refillsAuthorized) {
      violations.push({
        code: "CS_REFILL_LIMIT_EXCEEDED",
        reason: `This prescription authorizes ${rx.refillsAuthorized} refill(s); this would be refill ${refillNumber}.`,
        citation: "21 CFR 1306.22(a)",
      });
    }
  }

  // --- Six-month horizons. ---
  // Two independent bars, and their schedule coverage differs:
  //   § 1306.22(a) — ordinary fill or refill, Schedules III and IV.
  //   § 1306.23(c) — partial fill, Schedules III, IV, AND V.
  // Schedule V therefore has NO federal six-month bar on a complete
  // fill, but does have one on a partial fill. That is the regulation,
  // not an oversight here.
  const sixMonthDeadline = addUtcCalendarMonths(rx.originalDateWritten, 6);
  const ordinaryHorizonApplies = hasSixMonthRefillHorizon(rx.schedule) && !isPartial;
  const partialHorizonApplies = hasScheduleThreeToFivePartialFillRegime(rx.schedule) && isPartial;
  if ((ordinaryHorizonApplies || partialHorizonApplies) && asOfDay > sixMonthDeadline) {
    violations.push({
      code: "CS_SIX_MONTH_HORIZON_ELAPSED",
      reason: `A ${rx.schedule} prescription may not be dispensed more than six months after it was issued.`,
      citation: partialHorizonApplies ? "21 CFR 1306.23(c)" : "21 CFR 1306.22(a)",
    });
  }

  // --- Quantity supplied for THIS fill must not exceed what was
  // --- prescribed for it.
  // 21 CFR 1306.13(b)(1)(iv) and 1306.13(c) for Schedule II;
  // 21 CFR 1306.23(b) for Schedules III–V. Scoped to the fill, since
  // `quantityAuthorized` is per fill and each refill re-authorizes
  // that quantity.
  const cumulative = request.quantityDispensedInFill + request.quantityToFill;
  if (cumulative > rx.quantityAuthorized) {
    violations.push({
      code: "CS_QUANTITY_EXCEEDS_AUTHORIZED",
      reason: `Dispensing ${request.quantityToFill} would bring the total to ${cumulative}, exceeding the authorized quantity of ${rx.quantityAuthorized}.`,
      citation:
        rx.schedule === ControlledSubstanceSchedule.CII
          ? "21 CFR 1306.13(b)(1)(iv)"
          : "21 CFR 1306.23(b)",
    });
  }

  // --- Schedule II partial-fill completion windows (§ 1306.13). ---
  const windowViolation = evaluateScheduleTwoPartialFillWindow(request);
  if (windowViolation !== null) {
    violations.push(windowViolation);
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * The § 1306.13 completion windows, which differ by basis:
 *
 *   (a) pharmacist supply shortfall — 72 hours from the first partial
 *       fill; beyond that "no further quantity may be supplied ...
 *       without a new prescription".
 *   (b)(2) patient or prescriber request — not later than 30 days
 *       after the date the prescription was written.
 *   (c) LTCF resident or terminal illness — the prescription is valid
 *       for no more than 60 days from issue.
 *
 * Only applies to a CONTINUATION (a dispensing after the first).
 */
function evaluateScheduleTwoPartialFillWindow(
  request: DispensingRequest
): DispensingViolation | null {
  const { prescription: rx } = request;
  if (rx.schedule !== ControlledSubstanceSchedule.CII) return null;
  if (request.partialFillBasis === null) return null;
  // A continuation is a dispensing that follows an earlier partial fill
  // of the SAME fill. The first partial fill starts the clock; it does
  // not run against itself.
  if (request.quantityDispensedInFill <= 0) return null;

  const asOfDay = startOfUtcDay(request.asOf);

  switch (request.partialFillBasis) {
    case "PHARMACIST_SUPPLY_SHORTFALL": {
      // Instant-precision, not date-precision: the regulation says 72
      // hours, not three days.
      if (request.firstPartialFillAt === null) return null;
      const elapsed = request.asOf.getTime() - request.firstPartialFillAt.getTime();
      if (elapsed > HOURS_72_MS) {
        return {
          code: "CS_SCHEDULE_II_PARTIAL_FILL_WINDOW_ELAPSED",
          reason:
            "The remaining portion of a Schedule II partial fill must be supplied within 72 hours of the first partial filling; a new prescription is now required.",
          citation: "21 CFR 1306.13(a)",
        };
      }
      return null;
    }
    case "PATIENT_OR_PRESCRIBER_REQUEST": {
      if (asOfDay > addUtcDays(rx.originalDateWritten, 30)) {
        return {
          code: "CS_SCHEDULE_II_PARTIAL_FILL_WINDOW_ELAPSED",
          reason:
            "Remaining portions of a requested Schedule II partial fill must be filled within 30 days of the date written.",
          citation: "21 CFR 1306.13(b)(2)",
        };
      }
      return null;
    }
    case "LTCF_OR_TERMINALLY_ILL": {
      if (asOfDay > addUtcDays(rx.originalDateWritten, 60)) {
        return {
          code: "CS_SCHEDULE_II_PARTIAL_FILL_WINDOW_ELAPSED",
          reason:
            "A Schedule II prescription for an LTCF or terminally ill patient is valid for no more than 60 days from the issue date.",
          citation: "21 CFR 1306.13(c)",
        };
      }
      return null;
    }
    case "SCHEDULE_III_TO_V":
      // Mismatched basis; already reported as
      // CS_PARTIAL_FILL_BASIS_INVALID_FOR_SCHEDULE.
      return null;
    default: {
      const exhaustive: never = request.partialFillBasis;
      return exhaustive;
    }
  }
}
