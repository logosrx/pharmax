// The probe registry.
//
// One array, one map, one duplicate guard. Everything that runs a
// compliance check resolves it through here, which gives the module a
// single answer to two questions an auditor will ask: what does the
// platform check, and is anything configured that the platform does
// not actually check?
//
// The second question is why `resolveCheck` returns undefined rather
// than throwing, and why the scheduler is expected to record a
// configuration error for an unresolvable `compliance_check` row. A
// database row with no code behind it must be loud. The failure mode
// this avoids is the worst one available to a monitoring system: a
// check that appears in the dashboard, has a green history, and stopped
// executing months ago.

import { errors } from "@pharmax/platform-core";

import { auditChainHeadConsistencyCheck } from "./audit/chain-head-consistency.js";
import { accessReviewFreshnessCheck } from "./identity/access-review-freshness.js";
import { elevatedSessionMfaSatisfiedCheck } from "./identity/elevated-session-mfa-satisfied.js";
import { mfaElevatedRoleEnrollmentCheck } from "./identity/mfa-elevated-role-enrollment.js";
import { terminatedUserRoleRetentionCheck } from "./identity/terminated-user-role-retention.js";
import { commandLogStuckRunningCheck } from "./integrity/command-log-stuck-running.js";
import { outboxDeadLetterBacklogCheck } from "./integrity/outbox-dead-letter-backlog.js";
import type { ComplianceCheckDefinition } from "../types.js";

export const COMPLIANCE_CHECK_DUPLICATE_CODE = "COMPLIANCE_CHECK_DUPLICATE_CODE";

/**
 * Every probe the platform knows how to run.
 *
 * Ordering is by subsystem then code, purely for readability — the
 * scheduler orders by `nextRunAt`, never by this array.
 */
export const COMPLIANCE_CHECKS: ReadonlyArray<ComplianceCheckDefinition> = Object.freeze([
  auditChainHeadConsistencyCheck,
  accessReviewFreshnessCheck,
  elevatedSessionMfaSatisfiedCheck,
  mfaElevatedRoleEnrollmentCheck,
  terminatedUserRoleRetentionCheck,
  commandLogStuckRunningCheck,
  outboxDeadLetterBacklogCheck,
]);

function buildRegistry(
  definitions: ReadonlyArray<ComplianceCheckDefinition>
): ReadonlyMap<string, ComplianceCheckDefinition> {
  const map = new Map<string, ComplianceCheckDefinition>();
  for (const definition of definitions) {
    if (map.has(definition.code)) {
      // Thrown at module load. A duplicate code means two probes
      // write runs under one identity, so the history for that code
      // interleaves two different questions and neither can be
      // reconstructed afterwards.
      throw new errors.InternalError({
        code: COMPLIANCE_CHECK_DUPLICATE_CODE,
        message: `Duplicate compliance check code "${definition.code}".`,
        metadata: { code: definition.code },
      });
    }
    map.set(definition.code, definition);
  }
  return map;
}

export const COMPLIANCE_CHECK_REGISTRY: ReadonlyMap<string, ComplianceCheckDefinition> =
  buildRegistry(COMPLIANCE_CHECKS);

/**
 * Look up a probe by code. Returns undefined for an unknown code so
 * the caller can record a configuration error against the row rather
 * than crashing the whole scheduler tick — one misconfigured check
 * must not stop the other twenty from running.
 */
export function resolveCheck(code: string): ComplianceCheckDefinition | undefined {
  return COMPLIANCE_CHECK_REGISTRY.get(code);
}

/** Control codes referenced by at least one registered probe. */
export function registeredControlCodes(): ReadonlySet<string> {
  const codes = new Set<string>();
  for (const definition of COMPLIANCE_CHECKS) {
    for (const controlCode of definition.controlCodes) codes.add(controlCode);
  }
  return codes;
}
