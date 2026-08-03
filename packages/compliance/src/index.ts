// Public surface of @pharmax/compliance.
//
// The continuous-monitoring half of the SOC 2 / HIPAA program. The
// documented half already exists under docs/soc2/; this package is
// what keeps it honest by re-verifying the claims on a schedule and
// writing append-only evidence of each verification.
//
// What lives here:
//
//   - types: the probe contract. A probe reports PASS / FAIL /
//     NOT_APPLICABLE about the platform or one tenant; only the
//     runner may conclude ERROR.
//
//   - checks: `defineCheck` (validation at module load), the probe
//     registry, the runner, and the probes themselves.
//
// What deliberately does NOT live here:
//
//   - Persistence. The runner returns records; commands own the
//     writes, so every mutation of the compliance ledger goes through
//     the command bus with idempotency and audit like any other
//     critical mutation.
//
//   - Scheduling. apps/worker owns the poll loop.
//
//   - Any LLM call. Drafting policy text and proposing control
//     mappings is advisory work that belongs behind an explicit
//     human-acceptance step; a model must never be able to move a
//     control to a passing state. That boundary is a separate package
//     precisely so this one cannot be given the capability by
//     accident.

export type {
  ComplianceCadence,
  ComplianceCheckContext,
  ComplianceCheckDefinition,
  ComplianceCheckOutcome,
  ComplianceCheckRunRecord,
  ComplianceCheckSeverity,
  ComplianceFinding,
  ComplianceJsonValue,
  ComplianceProbeOutcome,
  ComplianceVerdict,
} from "./types.js";

export {
  COMPLIANCE_CHECK_CODE_INVALID,
  COMPLIANCE_CHECK_INTERVAL_INVALID,
  COMPLIANCE_CHECK_NO_CONTROLS,
  defineCheck,
} from "./checks/define-check.js";

export {
  COMPLIANCE_DETAILS_VERSION,
  COMPLIANCE_PROBE_RETURNED_NO_VERDICTS,
  COMPLIANCE_PROBE_THREW,
  computeComplianceDigest,
  runComplianceCheck,
} from "./checks/run-check.js";

export {
  COMPLIANCE_CHECK_DUPLICATE_CODE,
  COMPLIANCE_CHECK_REGISTRY,
  COMPLIANCE_CHECKS,
  registeredControlCodes,
  resolveCheck,
} from "./checks/registry.js";

export {
  forEachActiveOrganization,
  type ComplianceOrganizationRef,
} from "./checks/per-organization.js";

export { auditChainHeadConsistencyCheck } from "./checks/audit/chain-head-consistency.js";
export {
  ACCESS_REVIEW_MAX_AGE_DAYS,
  accessReviewFreshnessCheck,
} from "./checks/identity/access-review-freshness.js";
export { elevatedSessionMfaSatisfiedCheck } from "./checks/identity/elevated-session-mfa-satisfied.js";
export { mfaElevatedRoleEnrollmentCheck } from "./checks/identity/mfa-elevated-role-enrollment.js";
export { terminatedUserRoleRetentionCheck } from "./checks/identity/terminated-user-role-retention.js";
export {
  STUCK_COMMAND_THRESHOLD_MINUTES,
  commandLogStuckRunningCheck,
} from "./checks/integrity/command-log-stuck-running.js";
export { outboxDeadLetterBacklogCheck } from "./checks/integrity/outbox-dead-letter-backlog.js";
