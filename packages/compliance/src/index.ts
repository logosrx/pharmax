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
//   - Persistence and scheduling. The runner returns records; the
//     worker's poll loop writes them. Machine-generated runs are
//     written directly rather than through the command bus because a
//     platform-wide probe has no organizationId for `command_log` —
//     the same constraint break-glass documents in
//     packages/security/src/break-glass/SCHEMA.md — and the evidence
//     tables are themselves the append-only ledger. Human-initiated
//     mutations (SignOffControl, AcceptCheckException) DO go through
//     the bus, because there an actor with a real tenancy exists to
//     attribute the decision to.
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

export {
  AcceptCheckException,
  COMPLIANCE_CHECK_NOT_FOUND,
  COMPLIANCE_EXCEPTION_ALREADY_ACTIVE,
  COMPLIANCE_EXCEPTION_MAX_DAYS,
  COMPLIANCE_EXCEPTION_REASON_CODES,
  type AcceptCheckExceptionInput,
  type AcceptCheckExceptionOutput,
} from "./commands/accept-check-exception.js";

export {
  COMPLIANCE_CONTROL_HAS_FAILING_CHECKS,
  COMPLIANCE_CONTROL_NOT_FOUND,
  SignOffControl,
  type SignOffControlInput,
  type SignOffControlOutput,
} from "./commands/sign-off-control.js";

export {
  CONTROLS_INVENTORY_BAD_CONTROL_CODE,
  CONTROLS_INVENTORY_DUPLICATE_CODE,
  CONTROLS_INVENTORY_NO_CONTROLS,
  CONTROLS_INVENTORY_UNKNOWN_CADENCE,
  CONTROLS_INVENTORY_UNKNOWN_STATUS,
  extractImplementationRefs,
  parseControlsInventory,
  resolveCadence,
  type ParsedCadence,
  type ParsedControl,
  type ParsedControlStatus,
} from "./seed/parse-controls-inventory.js";
export {
  parseCriteriaFamilies,
  resolveCriterionTitle,
  type CriterionFamilyTitles,
} from "./seed/parse-criteria-families.js";
export {
  MARKDOWN_TABLE_RAGGED_ROW,
  columnIndex,
  parseMarkdownTables,
  type MarkdownTable,
  type MarkdownTableWithHeading,
} from "./seed/parse-markdown-table.js";

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
