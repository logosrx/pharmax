// ReleaseHold — close an active hold and return the order to its
// pre-hold state.
//
// Companion to `PlaceHold`. Together they implement the platform's
// first REVERSIBLE structured-record pattern:
//
//   - PlaceHold INSERTs a new `order_hold` row, flips order to ON_HOLD.
//   - ReleaseHold UPDATEs the SAME row (the one with `releasedAt
//     IS NULL` for this order — the partial unique guarantees there
//     is at most one), flips the order back to the row's
//     `heldFromStatus`, and emits `order.hold_released.v1`.
//
// Why update vs. insert-a-release-record:
//
//   - Reporting wants "how long was this order on hold?" answered
//     from a single row (`releasedAt - heldAt`). Splitting place
//     and release into two tables forces a JOIN on every report.
//   - The "active hold lookup" query (this command's primary
//     lookup) becomes `WHERE orderId = ? AND releasedAt IS NULL`,
//     served by the partial unique index. No JOIN.
//   - The structural anti-double-place / anti-orphan-release
//     guarantees both live on the same row.
//
// Workflow-safety rule satisfied here (see
// `.cursor/rules/01-workflow-safety.mdc`):
//
//   "Every hold requires a reason code."
//   "Every reopen requires a reason code."
//
//   Hold PLACEMENT carried a reason (HoldReason); RELEASE accepts
//   an OPTIONAL `releaseReason` (HoldReleaseReason). We don't
//   require one because operationally the placement reason already
//   tells the story and the release event timestamp + actor is the
//   forensic signal; supplying a release reason is encouraged
//   (helps the dispatcher understand "why was this released
//   without info received?") but not required. `OTHER` is the
//   exception — choosing `OTHER` requires `releaseReasonText`.
//
//   - releaseReason          → optional HoldReleaseReason enum
//   - releaseReasonText      → optional free text (required for OTHER)
//   - releaser stamp         → releasedByUserId
//   - command_log            → the bus's pre-tx command_log row
//   - order_event            → factory writes per declared `emits[]`
//   - audit_log              → bus writes via the hash-chained writer
//   - event_outbox           → bus writes per declared `emits[]`
//
// Parameterized transition:
//
//   The engine treats RELEASE_HOLD as a parameterized transition.
//   `applyTransition` requires `releaseToState`. We read that
//   value from the active hold row's `heldFromStatus` — it is the
//   row that recorded the state-before-hold, so restoring to it
//   is the natural default. The engine validates that
//   `releaseToState` is non-terminal and not `ON_HOLD`; for v1
//   that is sufficient because `heldFromStatus` is constrained
//   by `HOLD_FROM_STATES` at place time.
//
//   A future v2 may add an `overrideReleaseToState` input
//   parameter (with a separate permission) to support
//   supervisor-directed re-routes; the current shape leaves room
//   for that without a schema change because `releasedToStatus`
//   on the row is stored explicitly.
//
// PHI invariant (mirrors PlaceHold):
//
//   - `releaseReasonText` MAY contain PHI; redacted from
//     `command_log.requestPayload`. Audit + outbox carry only
//     `hasReleaseReasonText: boolean`. The text lives only on the
//     row.
//
// SoD invariant:
//
//   No `sodRules` declared today. ORDERS_RELEASE_HOLD is not
//   currently constrained by who placed the hold; this is the
//   asymmetric spot where a future "the actor who placed the hold
//   cannot release it" rule would land (operational policies vary
//   — some pharmacies want the same person closing the loop; some
//   require a second pair of eyes). The audit metadata records
//   both placement and release actors so an after-the-fact policy
//   review can answer the question.
//
// Idempotency:
//
//   Bus-level via `idempotencyKey`. Structural: ReleaseHold
//   requires an active hold row to exist (we throw
//   ORDER_NOT_ON_HOLD if not). A second ReleaseHold attempt on
//   the same hold cycle finds no row matching `WHERE releasedAt
//   IS NULL` and lands on ORDER_NOT_ON_HOLD. (Idempotent retry
//   replays from the bus cache; a NEW command id will not.)

import { defineCommand } from "@pharmax/command-bus";
import { HoldReleaseReason, OrderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import {
  closeOpenStageInterval,
  intervalKindForOrderState,
  isActiveIntervalKind,
  openStageInterval,
  OrderStageIntervalKind,
} from "@pharmax/sla";
import {
  applyTransition,
  isOrderState,
  ORDER_STANDARD_V1,
  WORKFLOW_INVALID_TRANSITION,
  WORKFLOW_PARAM_INVALID,
  WORKFLOW_PARAM_REQUIRED,
  WORKFLOW_STATE_TERMINAL,
  WORKFLOW_UNKNOWN_COMMAND,
  type OrderState,
} from "@pharmax/workflow";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Error codes — stable, public, machine-matched.
// ---------------------------------------------------------------------------

export const ORDER_RELEASE_HOLD_POLICY_UNSUPPORTED = "ORDER_RELEASE_HOLD_POLICY_UNSUPPORTED";
export const ORDER_RELEASE_STATE_UNKNOWN = "ORDER_RELEASE_STATE_UNKNOWN";
export const ORDER_NOT_ON_HOLD = "ORDER_NOT_ON_HOLD";
export const ORDER_RELEASE_INVALID_TARGET = "ORDER_RELEASE_INVALID_TARGET";
export const ORDER_HOLD_RECORD_CORRUPT = "ORDER_HOLD_RECORD_CORRUPT";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
//
// `.strict()` rejects unknown keys at the boundary.
//
// `releaseReason` and `releaseReasonText` are both OPTIONAL. The
// `OTHER` reason requires text (same pattern as PlaceHold).

const inputSchema = z
  .object({
    orderId: z.uuid(),
    releaseReason: z
      .enum([
        HoldReleaseReason.RESOLVED,
        HoldReleaseReason.INFO_RECEIVED,
        HoldReleaseReason.ADMIN_OVERRIDE,
        HoldReleaseReason.OTHER,
      ])
      .optional(),
    /**
     * Optional free-text context. MAY contain PHI. Redacted from
     * `command_log.requestPayload`; replaced with a boolean
     * `hasReleaseReasonText` in audit + outbox. Required when
     * `releaseReason === OTHER`.
     */
    releaseReasonText: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.releaseReason !== HoldReleaseReason.OTHER ||
      (typeof v.releaseReasonText === "string" && v.releaseReasonText.trim().length > 0),
    {
      message:
        "releaseReasonText is required when releaseReason === OTHER. Choose a structured reason or supply free-text context.",
      path: ["releaseReasonText"],
    }
  );

export type ReleaseHoldInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ReleaseHoldOutput {
  readonly orderId: string;
  readonly holdId: string;
  readonly currentStatus: string;
  readonly releasedToStatus: string;
  readonly version: number;
  readonly transitionId: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const ReleaseHold = defineCommand<ReleaseHoldInput, ReleaseHoldOutput>({
  name: "ReleaseHold",
  inputSchema,
  permission: PERMISSIONS.ORDERS_RELEASE_HOLD,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  redactFields: ["releaseReasonText"],

  async exec({ tx, ctx, input, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "RELEASE_HOLD_NO_TARGET",
        message: "Locked target was not provided to ReleaseHold handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "RELEASE_HOLD_NO_POLICY",
        message: "Workflow policy was not loaded for ReleaseHold.",
      });
    }

    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: ORDER_RELEASE_HOLD_POLICY_UNSUPPORTED,
        message:
          "ReleaseHold handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: ORDER_RELEASE_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }

    // Pre-engine guard: the order MUST be ON_HOLD. We surface a
    // domain-specific code instead of letting the engine return
    // WORKFLOW_INVALID_TRANSITION so the API layer can return a
    // clear "order isn't held" message.
    if (target.currentStatus !== OrderStatus.ON_HOLD) {
      throw new errors.ConflictError({
        code: ORDER_NOT_ON_HOLD,
        message: "Order is not currently on hold; ReleaseHold requires currentStatus = ON_HOLD.",
        metadata: { orderId: target.id, currentStatus: target.currentStatus },
      });
    }

    // ---- Look up the active hold ----
    // The partial unique index makes findFirst's result
    // deterministic: 0 or 1 row. If 0 the table is structurally
    // inconsistent with the order's status (ON_HOLD without an
    // active hold row) — surface ORDER_HOLD_RECORD_CORRUPT so an
    // operator can investigate.
    const activeHold = await tx.orderHold.findFirst({
      where: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        releasedAt: null,
      },
      select: {
        id: true,
        heldFromStatus: true,
        heldByUserId: true,
      },
    });
    if (activeHold === null) {
      throw new errors.InternalError({
        code: ORDER_HOLD_RECORD_CORRUPT,
        message:
          "Order is ON_HOLD but no active hold row was found. " +
          "This indicates a data inconsistency; do not retry blindly.",
        metadata: { orderId: target.id },
      });
    }

    if (!isOrderState(activeHold.heldFromStatus)) {
      throw new errors.InternalError({
        code: ORDER_RELEASE_STATE_UNKNOWN,
        message: "Active hold row has an unrecognized heldFromStatus value.",
        metadata: { heldFromStatus: activeHold.heldFromStatus, orderId: target.id },
      });
    }
    const releaseToState: OrderState = activeHold.heldFromStatus;

    // ---- Pure-engine guard for the parameterized transition ----
    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState: target.currentStatus as OrderState,
      command: "RELEASE_HOLD",
      releaseToState,
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_PARAM_INVALID:
        case WORKFLOW_PARAM_REQUIRED:
          // The hold row stored a forbidden releaseToState (e.g. a
          // future migration loosened HOLD_FROM_STATES then tightened
          // it again, leaving stale rows). Forensic data is intact;
          // the operator will need a supervisor override.
          throw new errors.ConflictError({
            code: ORDER_RELEASE_INVALID_TARGET,
            message: transition.reason,
            metadata: {
              orderId: target.id,
              heldFromStatus: releaseToState,
            },
          });
        case WORKFLOW_STATE_TERMINAL:
          // Unreachable: we already guarded against non-ON_HOLD
          // above. Re-raise as Internal so the alarm fires.
          throw new errors.InternalError({
            code: WORKFLOW_STATE_TERMINAL,
            message: transition.reason,
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.InternalError({
            code: WORKFLOW_INVALID_TRANSITION,
            message: transition.reason,
          });
        case WORKFLOW_UNKNOWN_COMMAND:
          throw new errors.InternalError({
            code: WORKFLOW_UNKNOWN_COMMAND,
            message: transition.reason,
          });
        default:
          throw new errors.InternalError({
            code: transition.code,
            message: transition.reason,
          });
      }
    }

    const now = clock.now();
    const releaseReasonText =
      typeof input.releaseReasonText === "string" && input.releaseReasonText.trim().length > 0
        ? input.releaseReasonText
        : null;
    const hasReleaseReasonText = releaseReasonText !== null;
    const releaseReason = input.releaseReason ?? null;

    // ---- Close the hold row ----
    // Conditional update keyed on `releasedAt: null` so a
    // concurrent ReleaseHold racer (e.g. one that bypassed the row
    // lock) can't double-close. The factory's CAS on `order.version`
    // is the primary anti-race; this is belt-and-suspenders. We use
    // `updateMany` (not `update`) because the conditional filter
    // includes `releasedAt: null` and Prisma's `update` requires a
    // unique WHERE.
    const closeResult = await tx.orderHold.updateMany({
      where: {
        id: activeHold.id,
        organizationId: ctx.organizationId,
        releasedAt: null,
      },
      data: {
        releasedAt: now,
        releasedByUserId: ctx.actor.userId,
        releasedToStatus: releaseToState as OrderStatus,
        releaseReason,
        releaseReasonText,
        releaseCommandLogId: commandLogId,
      },
    });
    if (closeResult.count !== 1) {
      // Either the row was closed concurrently or never existed.
      // Surface as ORDER_NOT_ON_HOLD — the API layer treats this
      // as a 409, same as the pre-guard path.
      throw new errors.ConflictError({
        code: ORDER_NOT_ON_HOLD,
        message: "Active hold was closed concurrently by another writer.",
        metadata: { orderId: target.id, holdId: activeHold.id },
      });
    }

    // ---- Flip the order back to its pre-hold status ----
    // currentBucketId intentionally unchanged: a held order kept
    // its bucket placement; on release the existing bucket is the
    // correct one for the restored status (status + bucket are
    // independent indexes; the queue scanner filters on both).
    // currentAssigneeUserId stays null — the operator who picks
    // up the released order claims it fresh.
    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: releaseToState as OrderStatus,
      },
    });

    // ---- SLA: close HOLD_ACTIVE + open the restored stage ----
    //
    // ReleaseHold cannot live in the static
    // `COMMAND_STAGE_INTERVAL_TRANSITION` table because the open
    // kind is parameterized by `heldFromStatus` (a hold placed
    // mid-typing reopens `TYPING_ACTIVE`; a hold placed during
    // `WAIT_BEFORE_FILL` reopens that wait window; etc.).
    //
    // `intervalKindForOrderState(releaseToState)` resolves the
    // canonical SLA kind for the restored state. It returns
    // `null` only for terminal states; `releaseToState` is the
    // hold row's `heldFromStatus`, which by construction is a
    // non-terminal, non-ON_HOLD state (the engine's
    // HOLD_FROM_STATES guard at place time + the param check on
    // RELEASE_HOLD above). A `null` here is a programmer error,
    // not a runtime data error — surface InternalError so the
    // breach evaluator and dashboards can alert.
    //
    // `actorUserId`: the releaser owns the restored work UNTIL a
    // fresh queue claim happens — but the assignee is nulled on
    // the order row by intent (operators pick released orders up
    // fresh). For consistency with WAIT_* intervals (no actor)
    // and ACTIVE intervals (actor = current owner), the schema
    // invariant `isActiveIntervalKind → actorUserId required`
    // is honored here: if the restored kind is ACTIVE we store
    // the releaser as the actor; if it's WAIT_* we pass null.
    // `openStageInterval` re-applies this coercion as defense
    // in depth, but doing it here keeps the audit metadata
    // accurate.
    const restoredKind = intervalKindForOrderState(releaseToState);
    if (restoredKind === null) {
      throw new errors.InternalError({
        code: ORDER_RELEASE_STATE_UNKNOWN,
        message:
          "Active hold restored to a terminal state — `intervalKindForOrderState` returned null. " +
          "This indicates a workflow-policy / SLA-map drift; do not retry.",
        metadata: { orderId: target.id, releaseToState },
      });
    }
    await closeOpenStageInterval({
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      endedAt: now,
      commandLogId,
      expectedKind: OrderStageIntervalKind.HOLD_ACTIVE,
    });
    await openStageInterval({
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      siteId: target.siteId,
      kind: restoredKind,
      startedAt: now,
      commandLogId,
      actorUserId: isActiveIntervalKind(restoredKind) ? ctx.actor.userId : null,
    });

    const nextVersion = target.version + 1;

    return {
      output: {
        orderId: target.id,
        holdId: activeHold.id,
        currentStatus: releaseToState,
        releasedToStatus: releaseToState,
        version: nextVersion,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: nextVersion },
      audit: {
        action: "order.hold_released",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          holdId: activeHold.id,
          fromState: transition.fromState,
          toState: transition.toState,
          transitionId: transition.transitionId,
          releaseReason,
          hasReleaseReasonText,
          heldByUserId: activeHold.heldByUserId,
          releasedByUserId: ctx.actor.userId,
          releasedToStatus: releaseToState,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.hold_released.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            holdId: activeHold.id,
            releaseReason,
            hasReleaseReasonText,
            heldByUserId: activeHold.heldByUserId,
            releasedByUserId: ctx.actor.userId,
            releasedToStatus: releaseToState,
            transitionId: transition.transitionId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});
