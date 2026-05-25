// CompleteTypingReview — close the typing stage and hand the order
// to PV1.
//
// Why this is the second verification command (after StartTyping):
//
//   StartTyping established the in-flight workflow pattern (lock +
//   load-policy-from-target + applyTransition + bump). This command
//   is the natural second instance — same shape, different
//   (fromState → toState) edge of the same v1 engine, different
//   destination bucket. Two commands using the pattern proves it
//   generalizes; downstream verification commands (`StartPV1`,
//   `ApprovePV1`, `RejectPV1`, …) are now mechanical applications.
//
// What this handler does inside the bus's tx (post-lock, post-policy):
//
//   1. Reject if the loaded policy isn't `order.standard@v1`. Same
//      replay-correctness guarantee as StartTyping — a v2 handler
//      will live in its own file when v2 ships.
//   2. Validate the (currentState, COMPLETE_TYPING_REVIEW) transition
//      via the pure engine. The engine's tagged-union result is
//      mapped to typed PharmaxError instances.
//   3. Resolve the PV1 bucket from `target.siteId` and the canonical
//      bucket code for `TYPED_READY_FOR_PV1` (the post-transition
//      state) — uses the shared `BUCKET_CODE_FOR_STATUS` map so the
//      lookup stays in sync with every other workflow command.
//   4. `order.update` — set `currentStatus = TYPED_READY_FOR_PV1`,
//      `currentBucketId = <pv1 bucket>`, and **clear**
//      `currentAssigneeUserId` (the typist is done; the order is now
//      in the PV1 queue waiting for a pharmacist to claim it via
//      `StartPV1`, which will set the assignee to the pharmacist).
//   5. The factory's `bumpVersion` CAS-bumps `version` in a separate
//      updateMany — same atomicity guarantee as StartTyping.
//
// Assignee-clear rationale:
//
//   Real pharmacy ops: the typist finishes, walks away, and the
//   order should appear in EVERY available PV1 pharmacist's queue
//   for selection — not be stuck displayed as "assigned to <typist>"
//   in a UI that needs to show pharmacist availability. Clearing
//   `currentAssigneeUserId` to NULL is the explicit signal "this
//   order has no current owner; the next-stage actor will claim
//   it". A separate audit trail (`order_event.actorUserId` on the
//   `order.typing.completed.v1` row) preserves WHO completed the
//   typing for traceability — clearing the live pointer doesn't
//   destroy the historical record.
//
// Reuse:
//
//   Error code constants `TYPING_POLICY_UNSUPPORTED`,
//   `TYPING_ORDER_STATE_UNKNOWN`, `TYPING_INVALID_TRANSITION`,
//   `TYPING_ORDER_TERMINAL` are imported from `./start-typing.js`
//   so both typing commands surface ONE stable code per failure
//   class (mirrors AddPrescription reusing CreateOrder's
//   `ORDER_PRESCRIPTION_MISMATCH`). The destination-bucket-missing
//   error gets its own code (`PV1_BUCKET_NOT_CONFIGURED`) because
//   the bucket being missing is a different misconfiguration than
//   "TYPING bucket missing on StartTyping" — operators need to
//   distinguish them in dashboards.
//
// SoD invariant:
//
//   No `sodRules` declared. There is no registered rule with
//   `attempted: TYPING_COMPLETE`; in real ops the typist completes
//   their own typing review (that's the whole point — they assert
//   they typed it correctly). The SoD constraint that matters
//   downstream is `PV1_APPROVE` vs. `TYPING_COMPLETE` by the same
//   actor — that fires on `ApprovePV1`, against the order's
//   `order_event` history, via the bus's SoD helper.
//
// SLA interval invariant:
//
//   Same as StartTyping: no `order_stage_interval` row is written
//   here. Phase 3 will retrofit every command to close the previous
//   interval (`TYPING_ACTIVE`) and open the next (`WAIT_BEFORE_PV1`)
//   in lockstep. The per-stage timestamps recorded TODAY (audit
//   `occurredAt`, `order_event.occurredAt`) are sufficient backfill
//   input when that table lands.
//
// PHI invariant:
//
//   Input carries `orderId` only. Audit metadata + outbox payload
//   reference scope (orderId, organizationId, siteId,
//   completedByUserId, bucketIdAfter) and workflow identity
//   (fromState, toState, transitionId, policyId, policyVersion) —
//   zero patient PHI.

import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { OrderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { applyCommandStageIntervalTransition } from "@pharmax/sla";
import {
  applyTransition,
  BUCKET_CODE_FOR_STATUS,
  ORDER_STANDARD_V1,
  WORKFLOW_INVALID_TRANSITION,
  WORKFLOW_STATE_TERMINAL,
  WORKFLOW_UNKNOWN_COMMAND,
  isOrderState,
  type OrderState,
} from "@pharmax/workflow";
import { z } from "zod";

import {
  TYPING_INVALID_TRANSITION,
  TYPING_ORDER_STATE_UNKNOWN,
  TYPING_ORDER_TERMINAL,
  TYPING_POLICY_UNSUPPORTED,
} from "./start-typing.js";

// ---------------------------------------------------------------------------
// Error codes — only the codes UNIQUE to CompleteTypingReview live
// here; shared typing-stage codes are imported above so callers get
// one stable code per failure class regardless of which typing
// command surfaced it.
// ---------------------------------------------------------------------------

export const PV1_BUCKET_NOT_CONFIGURED = "PV1_BUCKET_NOT_CONFIGURED";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
  })
  .strict();

export type CompleteTypingReviewInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface CompleteTypingReviewOutput {
  readonly orderId: string;
  readonly currentStatus: "TYPED_READY_FOR_PV1";
  readonly version: number;
  readonly transitionId: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const CompleteTypingReview = defineCommand<
  CompleteTypingReviewInput,
  CompleteTypingReviewOutput
>({
  name: "CompleteTypingReview",
  inputSchema,
  permission: PERMISSIONS.TYPING_COMPLETE,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  redactFields: [],

  async exec({ tx, ctx, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "COMPLETE_TYPING_NO_TARGET",
        message: "Locked target was not provided to CompleteTypingReview handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "COMPLETE_TYPING_NO_POLICY",
        message: "Workflow policy was not loaded for CompleteTypingReview.",
      });
    }

    // Policy version gate. Same shape as StartTyping; the typing-stage
    // unsupported-policy code is shared because operators reading the
    // error need to know "the typing-stage handlers don't recognize
    // this policy", regardless of which typing command threw.
    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: TYPING_POLICY_UNSUPPORTED,
        message:
          "CompleteTypingReview handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: TYPING_ORDER_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const currentState: OrderState = target.currentStatus;

    // Pure-engine guard. Result codes map to PharmaxError with the
    // shared typing-stage code vocabulary.
    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState,
      command: "COMPLETE_TYPING_REVIEW",
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_STATE_TERMINAL:
          throw new errors.ConflictError({
            code: TYPING_ORDER_TERMINAL,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.ConflictError({
            code: TYPING_INVALID_TRANSITION,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_UNKNOWN_COMMAND:
          // Programmer error — engine has no row for COMPLETE_TYPING_REVIEW.
          throw new errors.InternalError({
            code: WORKFLOW_UNKNOWN_COMMAND,
            message: transition.reason,
          });
        default:
          // WORKFLOW_PARAM_* don't apply to the unparameterized
          // COMPLETE_TYPING_REVIEW transition. Defensive fallthrough.
          throw new errors.InternalError({
            code: transition.code,
            message: transition.reason,
          });
      }
    }

    // Destination bucket: the canonical bucket for the post-transition
    // state (TYPED_READY_FOR_PV1 → "PV1"). Shared map keeps the lookup
    // consistent with CreateOrder ("INBOX") and StartTyping ("TYPING").
    const pv1BucketCode = BUCKET_CODE_FOR_STATUS.TYPED_READY_FOR_PV1;
    const pv1Bucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: pv1BucketCode,
      },
      select: { id: true },
    });
    if (pv1Bucket === null) {
      throw new errors.InternalError({
        code: PV1_BUCKET_NOT_CONFIGURED,
        message: `No ${pv1BucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: pv1BucketCode },
      });
    }

    // `completedByUserId` is the actor — the user the bus authenticated
    // as performing this command. In typical ops this is the same user
    // who held `currentAssigneeUserId` (the typist completes their own
    // typing), but the order_event row written by the factory will
    // carry `actorUserId = completedByUserId` either way, which is the
    // audit-trail source of truth. We deliberately do NOT read the
    // previous `currentAssigneeUserId` here — `LockedOrderTarget` does
    // not currently project that column, and widening the projection
    // is a cross-cutting refactor (touches every in-flight command's
    // test fakes). When a downstream report genuinely needs the
    // previous-assignee field on this event, widen `LockedOrderTarget`
    // in one PR and add `previousAssigneeUserId` to audit/outbox in
    // lockstep across every state-transition command.
    const completedByUserId = ctx.actor.userId;

    // Domain write: state + bucket + ASSIGNEE-CLEAR. Setting
    // `currentAssigneeUserId: null` releases the order from the typist
    // so the PV1 queue UI shows it as unassigned (the next pharmacist
    // claims it via `StartPV1`). The historical "typist" identity is
    // preserved on the `order_event` row that the factory writes next.
    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.TYPED_READY_FOR_PV1,
        currentBucketId: pv1Bucket.id,
        currentAssigneeUserId: null,
      },
    });

    const now = clock.now();

    await applyCommandStageIntervalTransition({
      commandName: "CompleteTypingReview",
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      siteId: target.siteId,
      at: now,
      commandLogId,
      actorUserId: ctx.actor.userId,
    });

    return {
      output: {
        orderId: target.id,
        currentStatus: "TYPED_READY_FOR_PV1" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.typing.completed",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          fromState: transition.fromState,
          toState: transition.toState,
          transitionId: transition.transitionId,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          siteId: target.siteId,
          bucketIdAfter: pv1Bucket.id,
          completedByUserId,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.typing.completed.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            completedByUserId,
            bucketId: pv1Bucket.id,
            transitionId: transition.transitionId,
            fromState: transition.fromState,
            toState: transition.toState,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

// Re-export the bus's CAS error code so callers of
// `@pharmax/verification` don't have to import `@pharmax/command-bus`
// just to handle a 409 from CompleteTypingReview.
export { ORDER_VERSION_MISMATCH };
