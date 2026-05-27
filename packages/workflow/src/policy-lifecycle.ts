// Workflow policy lifecycle — pure selection rules.
//
// Companion to the lifecycle laid out in ADR-0017
// (`docs/adr/0017-workflow-policy-migration.md`). This module
// owns the create-side selection rule: given a set of candidate
// policy rows for one tenant + code, which row should a brand-new
// `CreateOrder` stamp onto the new order?
//
// The in-flight selection (for `loadPolicy: { from: "target" }`)
// is the other half of the lifecycle contract and lives in
// `@pharmax/command-bus` because it reads the locked target row
// inside the bus transaction. That path widens to `ACTIVE |
// SUPERSEDED` per the grandfather rule.
//
// Why a pure function rather than baking the rule into the bus's
// `resolvePolicy`:
//
//   - The rule is *deterministic from inputs* and has zero I/O —
//     same candidates, same code, same version → same result.
//     Testable in isolation without a database or Prisma fake.
//   - Reusable from migration scripts and operator tooling that
//     need to ask "which version of `order.standard` would a new
//     order be stamped with right now?" without spinning up the
//     full command bus.
//   - The bus delegates to this function when it implements the
//     `{code, version}` path, so the activation invariant stays
//     defined in one place. The DB partial unique index
//     (`workflow_policy_active_unique`) plus this function form
//     the layered enforcement: the DB makes "two ACTIVE rows for
//     (organizationId, code)" impossible at write time, and this
//     function assumes that invariant when selecting.
//
// Status values are kept as a literal-string union here rather
// than imported from `@pharmax/database` so this module stays
// dependency-light (no Prisma client import; no generated code on
// the workflow package's resolution graph). The values mirror the
// `WorkflowPolicyStatus` Prisma enum verbatim; a contract test
// across the two boundaries pins the parity.

export const WORKFLOW_POLICY_NOT_ACTIVE = "WORKFLOW_POLICY_NOT_ACTIVE" as const;
export const WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE = "WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE" as const;

export type PolicySelectionErrorCode =
  | typeof WORKFLOW_POLICY_NOT_ACTIVE
  | typeof WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE;

/**
 * Lifecycle status of a `WorkflowPolicy` row. Mirrors the
 * `WorkflowPolicyStatus` Prisma enum in `prisma/schema.prisma`.
 *
 *   - `DRAFT` — authored, not yet activated; rejected by every
 *     selector.
 *   - `ACTIVE` — current canonical row; at most one per
 *     (organizationId, code) by the partial unique index.
 *   - `SUPERSEDED` — previously ACTIVE, replaced by a newer
 *     ACTIVE row. Readable for in-flight orders (grandfather
 *     rule); rejected for new `CreateOrder` requests.
 *   - `ARCHIVED` — terminal decommission; rejected by every
 *     selector.
 */
export const WORKFLOW_POLICY_STATUS_VALUES = ["DRAFT", "ACTIVE", "SUPERSEDED", "ARCHIVED"] as const;

export type WorkflowPolicyStatusValue = (typeof WORKFLOW_POLICY_STATUS_VALUES)[number];

/** Statuses a `loadPolicy: { code, version }` lookup may accept. */
export const CREATE_READABLE_STATUSES: ReadonlyArray<WorkflowPolicyStatusValue> = ["ACTIVE"];

/**
 * Statuses a `loadPolicy: { from: "target" }` lookup may accept.
 * Wider than the create path because in-flight orders carry on
 * under their born policy even after newer versions activate.
 */
export const IN_FLIGHT_READABLE_STATUSES: ReadonlyArray<WorkflowPolicyStatusValue> = [
  "ACTIVE",
  "SUPERSEDED",
];

export function isWorkflowPolicyStatus(value: string): value is WorkflowPolicyStatusValue {
  return (WORKFLOW_POLICY_STATUS_VALUES as ReadonlyArray<string>).includes(value);
}

/**
 * One candidate row passed into `pickPolicyForCreate`. The caller
 * is responsible for scoping `candidates` to a single tenant
 * before passing them in — this function does NOT filter by
 * `organizationId` because the lifecycle rules are invariant
 * across tenancy.
 */
export interface WorkflowPolicyCandidate {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly status: WorkflowPolicyStatusValue;
}

export interface PickPolicyForCreateInput {
  readonly candidates: ReadonlyArray<WorkflowPolicyCandidate>;
  readonly code: string;
  /**
   * When set, the selector restricts itself to the candidate
   * matching `(code, requestedVersion)`. Used by tests and
   * migration scripts that want deterministic behavior across an
   * activation flip. When omitted, the selector returns the
   * single ACTIVE candidate for `code` (the activation invariant
   * guarantees at most one).
   */
  readonly requestedVersion?: number;
}

export type PickPolicyForCreateResult =
  | { readonly ok: true; readonly policy: WorkflowPolicyCandidate }
  | { readonly ok: false; readonly code: PolicySelectionErrorCode; readonly reason: string };

/**
 * Pick the workflow policy a `CreateOrder` should stamp onto a
 * new order.
 *
 * Rules (encoded by the implementation below):
 *
 *   - With `requestedVersion`:
 *     - Find candidate matching `(code, requestedVersion)`.
 *     - If `status === "ACTIVE"` → `{ ok: true, policy }`.
 *     - If exists but other status → `WORKFLOW_POLICY_NOT_ACTIVE`.
 *     - If absent → `WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE`.
 *
 *   - Without `requestedVersion`:
 *     - Find all candidates matching `code`.
 *     - If exactly one is ACTIVE → return it. (More than one
 *       ACTIVE would violate the partial unique index; the
 *       function still works correctly — picks the first ACTIVE
 *       — but the DB would have rejected the second activation
 *       at write time.)
 *     - If at least one candidate matches `code` but none are
 *       ACTIVE → `WORKFLOW_POLICY_NOT_ACTIVE`.
 *     - If no candidates match `code` →
 *       `WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE`.
 *
 * Pure: no I/O, no clock, no entropy, no exceptions thrown for
 * expected failure modes (returns `{ ok: false, ... }`). The bus
 * (or a higher-level caller) translates the failure code into a
 * `PharmaxError` instance when applicable.
 */
export function pickPolicyForCreate(input: PickPolicyForCreateInput): PickPolicyForCreateResult {
  if (input.requestedVersion !== undefined) {
    return pickPinnedVersion(input.candidates, input.code, input.requestedVersion);
  }
  return pickCurrentActive(input.candidates, input.code);
}

function pickPinnedVersion(
  candidates: ReadonlyArray<WorkflowPolicyCandidate>,
  code: string,
  requestedVersion: number
): PickPolicyForCreateResult {
  const match = candidates.find((c) => c.code === code && c.version === requestedVersion);
  if (match === undefined) {
    return {
      ok: false,
      code: WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE,
      reason: `No workflow policy row matches code=${code} version=${requestedVersion}.`,
    };
  }
  if (match.status !== "ACTIVE") {
    return {
      ok: false,
      code: WORKFLOW_POLICY_NOT_ACTIVE,
      reason: `Workflow policy ${code} v${requestedVersion} is ${match.status}; CreateOrder requires ACTIVE.`,
    };
  }
  return { ok: true, policy: match };
}

function pickCurrentActive(
  candidates: ReadonlyArray<WorkflowPolicyCandidate>,
  code: string
): PickPolicyForCreateResult {
  const matching = candidates.filter((c) => c.code === code);
  if (matching.length === 0) {
    return {
      ok: false,
      code: WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE,
      reason: `No workflow policy row matches code=${code}.`,
    };
  }
  const active = matching.find((c) => c.status === "ACTIVE");
  if (active === undefined) {
    return {
      ok: false,
      code: WORKFLOW_POLICY_NOT_ACTIVE,
      reason: `Workflow policy ${code} has no ACTIVE row; available versions: ${matching
        .map((c) => `v${c.version}=${c.status}`)
        .join(", ")}.`,
    };
  }
  return { ok: true, policy: active };
}

// ===========================================================================
// Policy version lifecycle (registration + activation rules)
// ===========================================================================

/**
 * Pure validators for the policy lifecycle commands. The actual
 * `RegisterPolicyVersion` / `ActivatePolicyVersion` commands are
 * implemented as `Command<TInput, TOutput>` objects in the
 * domain admin layer — they call these pure rules first, then
 * write to `workflow_policy` inside the bus tx.
 *
 * Splitting the rules out keeps:
 *   - The lifecycle math testable without a tx / fake Prisma.
 *   - The Command<I, O> implementation thin (validate via these,
 *     then a single Prisma update).
 *   - The replay story honest — given the same candidate set and
 *     input, these always return the same result.
 */

export const POLICY_VERSION_DUPLICATE = "POLICY_VERSION_DUPLICATE" as const;
export const POLICY_VERSION_NOT_INCREMENTAL = "POLICY_VERSION_NOT_INCREMENTAL" as const;
export const POLICY_VERSION_BREAKING_NARROWING = "POLICY_VERSION_BREAKING_NARROWING" as const;
export const POLICY_VERSION_NOT_DRAFT = "POLICY_VERSION_NOT_DRAFT" as const;

export type PolicyLifecycleErrorCode =
  | typeof POLICY_VERSION_DUPLICATE
  | typeof POLICY_VERSION_NOT_INCREMENTAL
  | typeof POLICY_VERSION_BREAKING_NARROWING
  | typeof POLICY_VERSION_NOT_DRAFT
  | PolicySelectionErrorCode
  | OverlayLifecycleErrorCode;

/**
 * Result of a pure validator. `{ ok: true }` means the input
 * passed every guard; the caller may proceed with the write.
 * `{ ok: false }` carries a stable error code for the bus to
 * map to a `PharmaxError`.
 */
export type LifecycleValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PolicyLifecycleErrorCode; readonly reason: string };

export interface RegisterPolicyVersionInput {
  readonly code: string;
  readonly version: number;
  /**
   * Transition ids declared by the new version. Used by the
   * narrowing check: every transitionId removed vs. the prior
   * ACTIVE version is a candidate for "in-flight orders depend
   * on this transition" rejection.
   */
  readonly transitionIds: ReadonlyArray<string>;
}

export interface ExistingPolicyVersionRow {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly status: WorkflowPolicyStatusValue;
  readonly transitionIds: ReadonlyArray<string>;
}

/**
 * Validates a `RegisterPolicyVersion` request against the existing
 * policy rows for `(organizationId, code)`. Pure.
 *
 * Rules:
 *   1. `version` must not equal any existing row's version
 *      (DUPLICATE).
 *   2. `version` must be exactly `max(existing.version) + 1`
 *      (NOT_INCREMENTAL). Skipping numbers wrecks the audit
 *      story for "what was v3?".
 *   3. (Soft) NOT enforced here: removing transitions from prior
 *      ACTIVE — that becomes a check at ACTIVATION time when
 *      we know the in-flight order set. Registration only
 *      checks the SHAPE of the new version vs. its predecessors.
 *
 * Returns `{ ok: true }` to proceed, `{ ok: false, code, reason }`
 * to reject.
 */
export function validateRegisterPolicyVersion(
  input: RegisterPolicyVersionInput,
  existing: ReadonlyArray<ExistingPolicyVersionRow>
): LifecycleValidation {
  const sameCode = existing.filter((e) => e.code === input.code);
  if (sameCode.some((e) => e.version === input.version)) {
    return {
      ok: false,
      code: POLICY_VERSION_DUPLICATE,
      reason: `Policy ${input.code} v${input.version} already exists; pick a new version number.`,
    };
  }
  const maxVersion = sameCode.reduce((acc, e) => (e.version > acc ? e.version : acc), 0);
  if (sameCode.length === 0) {
    if (input.version !== 1) {
      return {
        ok: false,
        code: POLICY_VERSION_NOT_INCREMENTAL,
        reason: `First version of ${input.code} must be v1; got v${input.version}.`,
      };
    }
  } else if (input.version !== maxVersion + 1) {
    return {
      ok: false,
      code: POLICY_VERSION_NOT_INCREMENTAL,
      reason: `Policy ${input.code} version must be ${maxVersion + 1}; got v${input.version}.`,
    };
  }
  return { ok: true };
}

export interface ActivatePolicyVersionInput {
  readonly code: string;
  readonly version: number;
}

/**
 * Returns the set of transition ids the candidate ACTIVE version
 * declares MINUS the candidate DRAFT version. Empty set means
 * the new version is a strict superset of the prior active one
 * (or equal); a non-empty set is the list of transitions that
 * would be REMOVED on activation.
 *
 * The activation command uses this to check whether any in-flight
 * order under the prior version would lose access to a
 * transition it might need (rejected as
 * `POLICY_VERSION_BREAKING_NARROWING` when there ARE in-flight
 * orders on those transitions).
 */
export function diffPolicyTransitions(
  prior: ReadonlyArray<string>,
  next: ReadonlyArray<string>
): ReadonlyArray<string> {
  const nextSet = new Set(next);
  const removed: string[] = [];
  for (const id of prior) {
    if (!nextSet.has(id)) removed.push(id);
  }
  return removed;
}

/**
 * Validates an `ActivatePolicyVersion` request. The pure rule
 * set:
 *   1. Target row exists in `existing` → else NOT_FOUND.
 *   2. Target row is DRAFT → else NOT_DRAFT.
 *   3. Removed transitions (vs. prior ACTIVE) must have zero
 *      in-flight orders bound to those transitions → else
 *      BREAKING_NARROWING.
 *
 * `inFlightTransitionIds` is the caller-provided set of
 * transition ids that at least one in-flight order has used in
 * its order_event history. If empty, the narrowing check
 * trivially passes.
 *
 * Returns `{ ok: true }` to proceed.
 */
export function validateActivatePolicyVersion(
  input: ActivatePolicyVersionInput,
  candidates: ReadonlyArray<ExistingPolicyVersionRow>,
  inFlightTransitionIds: ReadonlyArray<string>
): LifecycleValidation {
  const target = candidates.find((c) => c.code === input.code && c.version === input.version);
  if (target === undefined) {
    return {
      ok: false,
      code: WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE,
      reason: `Policy ${input.code} v${input.version} not found.`,
    };
  }
  if (target.status !== "DRAFT") {
    return {
      ok: false,
      code: POLICY_VERSION_NOT_DRAFT,
      reason: `Policy ${input.code} v${input.version} is ${target.status}; activation requires DRAFT.`,
    };
  }
  const priorActive = candidates.find((c) => c.code === input.code && c.status === "ACTIVE");
  if (priorActive !== undefined) {
    const removed = diffPolicyTransitions(priorActive.transitionIds, target.transitionIds);
    const inFlight = new Set(inFlightTransitionIds);
    const breaking = removed.filter((id) => inFlight.has(id));
    if (breaking.length > 0) {
      return {
        ok: false,
        code: POLICY_VERSION_BREAKING_NARROWING,
        reason: `Activating ${input.code} v${input.version} would remove transitions still used by in-flight orders: ${breaking.join(", ")}.`,
      };
    }
  }
  return { ok: true };
}

// ===========================================================================
// Overlay lifecycle (registration / activation / deactivation)
// ===========================================================================

export const OVERLAY_NOT_FOUND = "OVERLAY_NOT_FOUND" as const;
export const OVERLAY_NOT_DRAFT = "OVERLAY_NOT_DRAFT" as const;
export const OVERLAY_NOT_ACTIVE = "OVERLAY_NOT_ACTIVE" as const;
export const OVERLAY_DEACTIVATION_BLOCKED = "OVERLAY_DEACTIVATION_BLOCKED" as const;

export type OverlayLifecycleErrorCode =
  | typeof OVERLAY_NOT_FOUND
  | typeof OVERLAY_NOT_DRAFT
  | typeof OVERLAY_NOT_ACTIVE
  | typeof OVERLAY_DEACTIVATION_BLOCKED;

export const OVERLAY_STATUS_VALUES = ["DRAFT", "ACTIVE", "SUPERSEDED", "ARCHIVED"] as const;
export type OverlayStatusValue = (typeof OVERLAY_STATUS_VALUES)[number];

export interface ExistingOverlayRow {
  readonly id: string;
  readonly basePolicyId: string;
  readonly version: number;
  readonly status: OverlayStatusValue;
  /** Transition ids the overlay tightens (forbid + attestation). */
  readonly affectedTransitionIds: ReadonlyArray<string>;
}

export interface ActivateOverlayInput {
  readonly overlayId: string;
}

/**
 * Validates `ActivateOverlay`. Pure.
 *
 * Rules:
 *   1. Target overlay exists → else NOT_FOUND.
 *   2. Target overlay is DRAFT → else NOT_DRAFT.
 *
 * The "tighten-only" invariant on the overlay shape is checked
 * by `mergePolicyWithOverlay` at MERGE TIME, not at activation
 * time. This means an admin CAN activate an overlay against a
 * base whose new version no longer declares one of the overlay's
 * referenced transitions — the merge will throw at the next
 * command dispatch. We accept that surface; admins must
 * re-validate overlays after a base activation (RUNBOOK).
 */
export function validateActivateOverlay(
  input: ActivateOverlayInput,
  candidates: ReadonlyArray<ExistingOverlayRow>
): LifecycleValidation {
  const target = candidates.find((c) => c.id === input.overlayId);
  if (target === undefined) {
    return {
      ok: false,
      code: OVERLAY_NOT_FOUND,
      reason: `Overlay ${input.overlayId} not found.`,
    };
  }
  if (target.status !== "DRAFT") {
    return {
      ok: false,
      code: OVERLAY_NOT_DRAFT,
      reason: `Overlay ${input.overlayId} is ${target.status}; activation requires DRAFT.`,
    };
  }
  return { ok: true };
}

export interface DeactivateOverlayInput {
  readonly overlayId: string;
}

/**
 * Validates `DeactivateOverlay`. Pure.
 *
 * Rules:
 *   1. Target overlay exists → else NOT_FOUND.
 *   2. Target overlay is ACTIVE → else NOT_ACTIVE.
 *   3. No in-flight orders depend on a transition the overlay
 *      ADDED ATTESTATIONS to. (Forbids do not block deactivation;
 *      removing a forbid loosens the surface, which is a no-op
 *      for in-flight orders that already passed the forbidden
 *      transition.) → else DEACTIVATION_BLOCKED.
 *
 * `inFlightAttestedTransitionIds` is the caller-provided set of
 * transition ids that at least one in-flight order has stamped
 * a require-attestation row against. If non-empty, deactivation
 * is blocked because in-flight orders may still need to satisfy
 * the attestation requirement on a future command.
 */
export function validateDeactivateOverlay(
  input: DeactivateOverlayInput,
  candidates: ReadonlyArray<ExistingOverlayRow>,
  inFlightAttestedTransitionIds: ReadonlyArray<string>
): LifecycleValidation {
  const target = candidates.find((c) => c.id === input.overlayId);
  if (target === undefined) {
    return {
      ok: false,
      code: OVERLAY_NOT_FOUND,
      reason: `Overlay ${input.overlayId} not found.`,
    };
  }
  if (target.status !== "ACTIVE") {
    return {
      ok: false,
      code: OVERLAY_NOT_ACTIVE,
      reason: `Overlay ${input.overlayId} is ${target.status}; deactivation requires ACTIVE.`,
    };
  }
  const inFlight = new Set(inFlightAttestedTransitionIds);
  const blocking = target.affectedTransitionIds.filter((id) => inFlight.has(id));
  if (blocking.length > 0) {
    return {
      ok: false,
      code: OVERLAY_DEACTIVATION_BLOCKED,
      reason: `Cannot deactivate overlay ${input.overlayId}: in-flight orders depend on attestations for transitions ${blocking.join(", ")}.`,
    };
  }
  return { ok: true };
}
