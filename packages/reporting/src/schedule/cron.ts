// Thin wrapper around `cron-parser` so the rest of the package
// imports a stable surface that we can swap libraries against
// without touching the call sites.
//
// What we use cron-parser for:
//   - `validateCron(expr, tz)` — does CreateReportSchedule's Zod
//     `.refine` accept this expression?
//   - `computeNextRun(expr, tz, from)` — given an expression
//     and the time the worker tick is processing, what's the
//     next fire? Used by CreateReportSchedule (initial
//     nextRunAt) and the worker tick (advance after run).
//
// Library: `cron-parser@4.x` — small, no native deps, supports
// IANA timezone via the `tz` option.

import cronParser from "cron-parser";

export interface CronValidationOk {
  readonly ok: true;
  readonly nextRunAt: Date;
}

export interface CronValidationFail {
  readonly ok: false;
  readonly error: string;
}

export type CronValidationResult = CronValidationOk | CronValidationFail;

/**
 * Validate a cron expression + timezone combination. Returns
 * `{ ok, nextRunAt }` so callers can both check validity AND
 * compute the initial fire time in one call.
 *
 * `from` defaults to `new Date()` so callers that just want
 * "is this expression valid right now" don't have to pass an
 * anchor.
 */
export function validateCron(input: {
  readonly expression: string;
  readonly timezone: string;
  readonly from?: Date;
}): CronValidationResult {
  const trimmed = input.expression.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "cron expression is empty" };
  }
  try {
    const interval = cronParser.parseExpression(trimmed, {
      currentDate: input.from ?? new Date(),
      tz: input.timezone,
    });
    const next = interval.next();
    return { ok: true, nextRunAt: next.toDate() };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "invalid cron expression",
    };
  }
}

/**
 * Compute the next-fire after `from` for a known-valid expression.
 * Throws if the expression doesn't parse (callers should have
 * already gone through `validateCron`).
 */
export function computeNextRun(input: {
  readonly expression: string;
  readonly timezone: string;
  readonly from: Date;
}): Date {
  const interval = cronParser.parseExpression(input.expression, {
    currentDate: input.from,
    tz: input.timezone,
  });
  return interval.next().toDate();
}
