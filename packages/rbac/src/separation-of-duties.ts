// Separation of Duties (SoD).
//
// SoD is the rule that says: the same actor cannot perform two
// conflicting steps in a workflow on the same resource. In pharmacy
// operations this is a HIPAA / state board / SOC 2 requirement, not
// a stylistic choice — a single pharmacist signing off both PV1 and
// final verification on the same prescription defeats the entire
// point of a two-pharmacist check.
//
// Design rules:
//   - Rules are pure data, registered at compile time. No DB lookups
//     for the rule set itself; the registry is closed.
//   - The check is a SYNCHRONOUS predicate against the resource's
//     ACT history (the bus passes `order_event` rows in for `order:*`
//     resources). No I/O, fully deterministic, fully testable.
//   - A violation throws `AuthorizationError(SOD_VIOLATION)`. The bus
//     surfaces it the same way as PERMISSION_DENIED: 403, expected,
//     no page.
//   - The history we inspect is a CALLER-supplied list of past acts
//     on the same resource. The bus computes this from the
//     `order_event` table inside the command transaction — so SoD
//     respects the same row lock as the rest of the command.
//   - SoD rules are TENANCY-AGNOSTIC. The same rule applies across
//     every clinic. (Per-clinic SoD configuration would be a phase-2
//     escape hatch; we don't have a customer asking for it.)
//
// What SoD does NOT do:
//   - Replace RBAC. A user without `FINAL_APPROVE` permission gets a
//     PERMISSION_DENIED from `requirePermission` first; SoD is the
//     SECOND check, after permissions pass.
//   - Look across resources. "The same pharmacist verified 10 of
//     Patient X's last 11 fills" is a *fraud detection* concern, not
//     SoD; it lives in the audit/analytics layer.

import { errors } from "@pharmax/platform-core";

import { PERMISSIONS, type PermissionCode } from "./permissions.js";

/** A past act on a resource that SoD rules can reference. */
export interface ResourceAct {
  readonly permission: PermissionCode;
  readonly actorUserId: string;
  /** ULID; only used for stable ordering when needed for diagnostics. */
  readonly atSequence?: string;
}

/** A single SoD rule. */
export interface SoDRule {
  /** Stable identifier. Used in audit metadata and admin docs. */
  readonly id: string;
  /** Human-facing summary; safe for the admin UI. */
  readonly summary: string;
  /**
   * The act the actor is about to perform. If this matches the
   * pending command, the rule's `forbiddenPriorActs` are checked
   * against the same-actor history.
   */
  readonly attempted: PermissionCode;
  /**
   * Permissions whose past execution by the SAME actor blocks the
   * `attempted` action on the same resource.
   */
  readonly forbiddenPriorActs: ReadonlyArray<PermissionCode>;
}

/**
 * Frozen registry of every SoD rule. Adding or removing a rule is a
 * SOC 2 audit event. Pair every change with:
 *   1. A test demonstrating the new violation flow.
 *   2. A note in the changelog.
 *   3. A migration plan if the rule retroactively forbids an act
 *      that existed in production data (queries on `order_event`
 *      will need a remediation plan).
 *
 * Why these specific rules:
 *   - PV1 + FINAL by same pharmacist: classic two-pharmacist check.
 *   - TYPING + PV1 by same actor: the typist who entered the
 *     prescription cannot be the pharmacist who first verifies it.
 *     EONPRO does not enforce this; HIPAA/board standards do.
 *   - FILL + FINAL by same actor: the tech who counted the pills
 *     cannot be the pharmacist who did the final check. (Different
 *     roles in the typical staffing model — this is belt-and-braces
 *     in case a user has both role assignments.)
 *   - PV1_APPROVE and PV1_REJECT by same actor on the same order
 *     would mean a pharmacist undoing their own approval; treated
 *     as a workflow violation, not SoD, and rejected by the state
 *     machine in `@pharmax/workflow`. NOT enforced here to avoid
 *     redundant errors.
 */
const RULES: ReadonlyArray<SoDRule> = [
  {
    id: "sod.pv1-final-same-actor",
    summary:
      "The pharmacist who approves PV1 on an order cannot also approve final verification on the same order.",
    attempted: PERMISSIONS.FINAL_APPROVE,
    forbiddenPriorActs: [PERMISSIONS.PV1_APPROVE],
  },
  {
    id: "sod.typing-pv1-same-actor",
    summary: "The typist who completes typing review cannot also approve PV1 on the same order.",
    attempted: PERMISSIONS.PV1_APPROVE,
    forbiddenPriorActs: [PERMISSIONS.TYPING_COMPLETE],
  },
  {
    id: "sod.fill-final-same-actor",
    summary:
      "The technician who completes fill cannot also approve final verification on the same order.",
    attempted: PERMISSIONS.FINAL_APPROVE,
    forbiddenPriorActs: [PERMISSIONS.FILL_COMPLETE],
  },
];

export const SOD_RULES: ReadonlyArray<SoDRule> = Object.freeze(
  RULES.map((r) =>
    Object.freeze({ ...r, forbiddenPriorActs: Object.freeze([...r.forbiddenPriorActs]) })
  )
);

/** Indexed view used by `checkSoD` for O(1) lookup by attempted permission. */
const RULES_BY_ATTEMPTED: ReadonlyMap<PermissionCode, ReadonlyArray<SoDRule>> = (() => {
  const m = new Map<PermissionCode, SoDRule[]>();
  for (const rule of SOD_RULES) {
    const existing = m.get(rule.attempted) ?? [];
    existing.push(rule);
    m.set(rule.attempted, existing);
  }
  const frozen = new Map<PermissionCode, ReadonlyArray<SoDRule>>();
  for (const [k, v] of m) frozen.set(k, v);
  return frozen;
})();

export const SOD_VIOLATION = "SOD_VIOLATION" as const;

export interface SoDViolation {
  readonly ruleId: string;
  readonly summary: string;
  readonly attemptedPermission: PermissionCode;
  /** Which prior act collided. Useful for the audit log and the UI. */
  readonly collidingPriorAct: PermissionCode;
  readonly priorActSequence: string | undefined;
}

/**
 * Pure SoD predicate. Returns `null` when the attempted action is
 * permitted by SoD, or a `SoDViolation` describing the first colliding
 * prior act when it is not.
 *
 * Multiple rules may apply to the same `attempted` permission; the
 * first violation found short-circuits and is reported. Order is
 * deterministic (the registry's declaration order) so the error
 * surface is stable.
 *
 * @param input.attempted        The permission code the actor is about to use.
 * @param input.actorUserId      The acting user.
 * @param input.resourceHistory  Past acts on the SAME resource (e.g. all
 *                               `order_event` rows for this order). Caller
 *                               supplies this from a row-locked query.
 */
export function checkSoD(input: {
  readonly attempted: PermissionCode;
  readonly actorUserId: string;
  readonly resourceHistory: ReadonlyArray<ResourceAct>;
}): SoDViolation | null {
  const rules = RULES_BY_ATTEMPTED.get(input.attempted);
  if (rules === undefined) return null;

  for (const rule of rules) {
    for (const prior of input.resourceHistory) {
      if (prior.actorUserId !== input.actorUserId) continue;
      if (!rule.forbiddenPriorActs.includes(prior.permission)) continue;
      return {
        ruleId: rule.id,
        summary: rule.summary,
        attemptedPermission: rule.attempted,
        collidingPriorAct: prior.permission,
        priorActSequence: prior.atSequence,
      };
    }
  }
  return null;
}

/**
 * Throwing wrapper. Use this from the command bus; the route handler
 * maps the resulting `AuthorizationError` to a 403 with PHI-free
 * details and writes an `SOD_VIOLATION` audit row.
 */
export function requireNoSoDViolation(input: {
  readonly attempted: PermissionCode;
  readonly actorUserId: string;
  readonly resourceHistory: ReadonlyArray<ResourceAct>;
  /** Stable identifier of the resource (e.g. `order:01J...`). Used in audit metadata only. */
  readonly resourceRef: string;
  /** Actor's correlation id for the request — propagated into the error metadata. */
  readonly correlationId: string;
  /** Organization id — propagated into the error metadata. */
  readonly organizationId: string;
}): void {
  const violation = checkSoD({
    attempted: input.attempted,
    actorUserId: input.actorUserId,
    resourceHistory: input.resourceHistory,
  });
  if (violation === null) return;

  throw new errors.AuthorizationError({
    code: SOD_VIOLATION,
    message: `Separation of duties violation: ${violation.summary}`,
    metadata: {
      ruleId: violation.ruleId,
      attemptedPermission: violation.attemptedPermission,
      collidingPriorAct: violation.collidingPriorAct,
      priorActSequence: violation.priorActSequence ?? null,
      resourceRef: input.resourceRef,
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      correlationId: input.correlationId,
    },
  });
}
