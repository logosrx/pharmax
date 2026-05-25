// StartFill — a fill tech claims an order from the FILL queue and
// begins the physical fill workflow.
//
// Why this is the first FILL-stage command:
//
//   ApprovePV1 cleared the assignee and parked the order in the FILL
//   bucket at `PV1_APPROVED_READY_FOR_FILL`. This command is the
//   counterpart to StartPV1 / StartFinalVerification — the tech
//   claims ownership, the status moves to `FILL_IN_PROGRESS`, and
//   downstream commands (`AssignLot`, `PrintVialLabel`,
//   `CompleteFill`) operate on an order the tech owns.
//
// Prerequisite invariant (workflow-safety.mdc):
//
//   START_FILL is only legal from `PV1_APPROVED_READY_FOR_FILL`.
//   The pure engine enforces "no fill before PV1 approval" — there
//   is no transition row from any pre-PV1 state. Attempting to fill
//   from `TYPED_READY_FOR_PV1` or `PV1_IN_PROGRESS` surfaces
//   `FILL_INVALID_TRANSITION`.
//
// SoD invariant:
//
//   No `sodRules` clause. The registry's fill-related rule is
//   `sod.fill-final-same-actor`, scoped to `attempted:
//   FINAL_APPROVE` (forbids prior `FILL_COMPLETE` by the same
//   actor). There is no rule for `attempted: FILL_START`. The
//   tech who completes the fill MUST NOT also approve final
//   verification — that constraint lands on `ApproveFinalVerification`,
//   not here. A tech may START a fill they didn't PV1-approve;
//   that's the normal handoff.
//
// Assignee semantics:
//
//   Symmetric to StartPV1: ApprovePV1 cleared the assignee to NULL;
//   this command sets `currentAssigneeUserId = ctx.actor.userId`.
//   CompleteFill will clear it again when the order enters the
//   FINAL queue.
//
// SLA interval invariant:
//
//   No `order_stage_interval` row yet — Phase 3 retrofits every
//   command in lockstep to close `WAIT_BEFORE_FILL` and open
//   `FILL_ACTIVE`.
//
// PHI invariant:
//
//   Input carries `orderId` only. Audit metadata + outbox payload
//   reference scope (orderId, organizationId, siteId,
//   fillTechUserId, bucketIdAfter) and workflow identity — zero
//   patient PHI.

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

// ---------------------------------------------------------------------------
// Error codes — stable, public, machine-matched.
//
// The FILL-stage error vocabulary mirrors the PV1-stage shape.
// `ApproveFinalVerification` / `CompleteFill` / `AssignLot` will
// REUSE these codes — one stable code per failure class per stage.
//
// `FILL_BUCKET_NOT_CONFIGURED` is the same string as
// `@pharmax/verification`'s `approve-pv1.ts` export so operators
// see one remediation regardless of which command surfaces a
// missing FILL bucket.
// ---------------------------------------------------------------------------

export const FILL_POLICY_UNSUPPORTED = "FILL_POLICY_UNSUPPORTED";
export const FILL_ORDER_STATE_UNKNOWN = "FILL_ORDER_STATE_UNKNOWN";
export const FILL_INVALID_TRANSITION = "FILL_INVALID_TRANSITION";
export const FILL_ORDER_TERMINAL = "FILL_ORDER_TERMINAL";
export const FILL_BUCKET_NOT_CONFIGURED = "FILL_BUCKET_NOT_CONFIGURED";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
  })
  .strict();

export type StartFillInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface StartFillOutput {
  readonly orderId: string;
  readonly currentStatus: "FILL_IN_PROGRESS";
  readonly version: number;
  readonly transitionId: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const StartFill = defineCommand<StartFillInput, StartFillOutput>({
  name: "StartFill",
  inputSchema,
  permission: PERMISSIONS.FILL_START,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  redactFields: [],

  async exec({ tx, ctx, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "START_FILL_NO_TARGET",
        message: "Locked target was not provided to StartFill handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "START_FILL_NO_POLICY",
        message: "Workflow policy was not loaded for StartFill.",
      });
    }

    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: FILL_POLICY_UNSUPPORTED,
        message:
          "StartFill handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: FILL_ORDER_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const currentState: OrderState = target.currentStatus;

    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState,
      command: "START_FILL",
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_STATE_TERMINAL:
          throw new errors.ConflictError({
            code: FILL_ORDER_TERMINAL,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.ConflictError({
            code: FILL_INVALID_TRANSITION,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
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

    // Destination bucket: PV1_APPROVED_READY_FOR_FILL → "FILL" AND
    // FILL_IN_PROGRESS → "FILL" — same bucket on both sides. The
    // lookup still runs because the shared status→bucket map is
    // the source of truth.
    const fillBucketCode = BUCKET_CODE_FOR_STATUS.FILL_IN_PROGRESS;
    const fillBucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: fillBucketCode,
      },
      select: { id: true },
    });
    if (fillBucket === null) {
      throw new errors.InternalError({
        code: FILL_BUCKET_NOT_CONFIGURED,
        message: `No ${fillBucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: fillBucketCode },
      });
    }

    const fillTechUserId = ctx.actor.userId;

    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.FILL_IN_PROGRESS,
        currentBucketId: fillBucket.id,
        currentAssigneeUserId: fillTechUserId,
      },
    });

    const now = clock.now();

    await applyCommandStageIntervalTransition({
      commandName: "StartFill",
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
        currentStatus: "FILL_IN_PROGRESS" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.fill.started",
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
          bucketIdAfter: fillBucket.id,
          fillTechUserId,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.fill.started.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            fillTechUserId,
            bucketId: fillBucket.id,
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

export { ORDER_VERSION_MISMATCH };
