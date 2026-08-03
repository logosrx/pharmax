// defineCheck — the constructor every probe goes through.
//
// Its job is to make a malformed probe fail at module load rather
// than at 3am on the night before an audit. Every rule below exists
// because the failure it prevents is silent:
//
//   - A duplicate or renamed `code` orphans historical runs, since
//     `compliance_check_run.checkCode` is frozen at write time.
//   - A probe with no `controlCodes` produces evidence for nothing,
//     so it costs a scheduler slot and buys no coverage.
//   - An automated cadence with no `intervalMinutes` never gets a
//     `nextRunAt`, so the scheduler skips it forever while the
//     dashboard shows it as configured.
//
// Loud at boot beats absent at audit.

import { errors } from "@pharmax/platform-core";

import type { ComplianceCheckDefinition } from "../types.js";

export const COMPLIANCE_CHECK_CODE_INVALID = "COMPLIANCE_CHECK_CODE_INVALID";
export const COMPLIANCE_CHECK_NO_CONTROLS = "COMPLIANCE_CHECK_NO_CONTROLS";
export const COMPLIANCE_CHECK_INTERVAL_INVALID = "COMPLIANCE_CHECK_INTERVAL_INVALID";

/**
 * Dotted lower-snake segments: `db.rls.tenant_table_coverage`.
 * Constrained so codes are safe as object keys, URL path segments,
 * metric label values, and email subject fragments without escaping.
 */
const CODE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Cadences the scheduler drives on a timer, and which therefore
 * require an interval. PER_EVENT and ON_CHANGE are triggered by
 * something else happening, so they legitimately have none.
 */
const SCHEDULER_DRIVEN_CADENCES = new Set([
  "CONTINUOUS",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "ANNUAL",
]);

export function defineCheck(definition: ComplianceCheckDefinition): ComplianceCheckDefinition {
  if (!CODE_PATTERN.test(definition.code)) {
    throw new errors.InternalError({
      code: COMPLIANCE_CHECK_CODE_INVALID,
      message:
        `Compliance check code "${definition.code}" is not dotted lower_snake ` +
        `(e.g. "db.rls.tenant_table_coverage").`,
      metadata: { code: definition.code },
    });
  }

  if (definition.controlCodes.length === 0) {
    throw new errors.InternalError({
      code: COMPLIANCE_CHECK_NO_CONTROLS,
      message:
        `Compliance check "${definition.code}" declares no controlCodes. ` +
        `A probe that evidences no control cannot justify its scheduler slot.`,
      metadata: { code: definition.code },
    });
  }

  const schedulerDriven = SCHEDULER_DRIVEN_CADENCES.has(definition.cadence);
  if (schedulerDriven && (definition.intervalMinutes ?? 0) <= 0) {
    throw new errors.InternalError({
      code: COMPLIANCE_CHECK_INTERVAL_INVALID,
      message:
        `Compliance check "${definition.code}" has cadence ${definition.cadence}, ` +
        `which the scheduler drives on a timer, but intervalMinutes is ` +
        `${String(definition.intervalMinutes)}. Without a positive interval it ` +
        `would never receive a nextRunAt and would silently never run.`,
      metadata: { code: definition.code, cadence: definition.cadence },
    });
  }
  if (!schedulerDriven && definition.intervalMinutes !== null) {
    throw new errors.InternalError({
      code: COMPLIANCE_CHECK_INTERVAL_INVALID,
      message:
        `Compliance check "${definition.code}" has cadence ${definition.cadence}, ` +
        `which is event-triggered, so intervalMinutes must be null.`,
      metadata: { code: definition.code, cadence: definition.cadence },
    });
  }

  return Object.freeze({
    ...definition,
    controlCodes: Object.freeze([...definition.controlCodes]),
  });
}
