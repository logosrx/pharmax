// Quarter math + period resolution for compliance jobs.
//
// SOC 2 + HIPAA evidence are produced on a calendar-quarter cadence
// (Q1 = Jan-Mar UTC). The job that produces them needs three things
// from a wall-clock instant:
//
//   1. The quarter LABEL for naming evidence artifacts ("2026-Q1").
//   2. The quarter WINDOW [start, end) so audit-log and command-log
//      queries can be precisely bounded.
//   3. A boolean: "is `now` the morning of the first day of a
//      quarter?" — used by the daily scheduler guard so the job
//      only acts on Jan 1 / Apr 1 / Jul 1 / Oct 1.
//
// All math is UTC. Local time would create silent off-by-one bugs
// when the worker pod is scheduled in a different region. The
// scheduler also uses UTC throughout.
//
// This file is pure — no Prisma, no clock side effects. All
// inputs are `Date` instances supplied by the caller, which keeps
// the unit tests trivial.

export interface QuarterPeriod {
  /** Calendar quarter year (e.g. 2026). */
  readonly year: number;
  /** Calendar quarter (1..4). */
  readonly quarter: 1 | 2 | 3 | 4;
  /** Label string for evidence artifact naming. */
  readonly label: string;
  /** Inclusive start of the quarter, UTC midnight. */
  readonly start: Date;
  /** Exclusive end (the start of the NEXT quarter), UTC midnight. */
  readonly end: Date;
}

/**
 * Return the quarter that ENDED most recently relative to `now`.
 *
 * On Jan 5 2026, this is `2025-Q4` (`[2025-10-01, 2026-01-01)`).
 * On Mar 31 2026 23:59, this is still `2025-Q4` because Q1 hasn't
 * fully closed yet — we report on the previous quarter.
 *
 * Used by the quarterly access-review job: on Apr 1 03:00 UTC we
 * report on Q1 (the quarter that just ended).
 */
export function resolveCompletedQuarter(now: Date): QuarterPeriod {
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const currentQuarterIndex = Math.floor(utcMonth / 3);
  let prevYear = utcYear;
  let prevQuarterIndex = currentQuarterIndex - 1;
  if (prevQuarterIndex < 0) {
    prevQuarterIndex = 3;
    prevYear = utcYear - 1;
  }
  return buildQuarterPeriod(prevYear, prevQuarterIndex);
}

/** Return the quarter CONTAINING `now`. */
export function resolveCurrentQuarter(now: Date): QuarterPeriod {
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const quarterIndex = Math.floor(utcMonth / 3);
  return buildQuarterPeriod(utcYear, quarterIndex);
}

/**
 * Return the quarter identified by `year` and `quarter` (1..4).
 * Throws RangeError on invalid inputs.
 */
export function quarterFromLabel(year: number, quarter: 1 | 2 | 3 | 4): QuarterPeriod {
  if (!Number.isInteger(year) || year < 1970) {
    throw new RangeError(`quarterFromLabel: year must be an integer ≥ 1970, got ${year}.`);
  }
  if (quarter < 1 || quarter > 4) {
    throw new RangeError(`quarterFromLabel: quarter must be 1..4, got ${String(quarter)}.`);
  }
  return buildQuarterPeriod(year, quarter - 1);
}

/**
 * True when `now` is on the FIRST DAY of a calendar quarter (UTC).
 * Used as the per-day guard inside the daily scheduler so the
 * quarterly job only acts on Jan 1, Apr 1, Jul 1, Oct 1.
 */
export function isFirstDayOfQuarter(now: Date): boolean {
  return now.getUTCDate() === 1 && now.getUTCMonth() % 3 === 0;
}

/** Parse a "YYYY-Q#" label into a QuarterPeriod. */
export function parseQuarterLabel(label: string): QuarterPeriod {
  const match = /^(\d{4})-Q([1-4])$/.exec(label);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new RangeError(`parseQuarterLabel: expected "YYYY-Q#", got ${JSON.stringify(label)}.`);
  }
  const year = Number.parseInt(match[1], 10);
  const quarter = Number.parseInt(match[2], 10) as 1 | 2 | 3 | 4;
  return buildQuarterPeriod(year, quarter - 1);
}

function buildQuarterPeriod(year: number, quarterIndex: number): QuarterPeriod {
  const startMonth = quarterIndex * 3;
  const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, startMonth + 3, 1, 0, 0, 0, 0));
  const quarter = (quarterIndex + 1) as 1 | 2 | 3 | 4;
  return {
    year,
    quarter,
    label: `${String(year)}-Q${String(quarter)}`,
    start,
    end,
  };
}
