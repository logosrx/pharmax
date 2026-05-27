// ReopenForCorrection — move a rejected order back into an earlier
// workflow stage for rework.
//
// Reachable only from rejection exception states:
//   - PV1_REJECTED → TYPING_IN_PROGRESS | TYPED_READY_FOR_PV1
//   - FINAL_VERIFICATION_REJECTED → FILL_IN_PROGRESS |
//     FILL_COMPLETED_READY_FOR_FINAL
//
// The pure engine validates `reopenToState` against
// REOPEN_TARGETS_BY_SOURCE. This command writes an append-only
// `order_correction_reopen` row and updates the order status +
// bucket + assignee.

import { defineCommand } from "@pharmax/command-bus";
import { ReopenReason, type OrderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import {
  closeOpenStageInterval,
  intervalKindForOrderState,
  isActiveIntervalKind,
  openStageInterval,
} from "@pharmax/sla";
import {
  applyTransition,
  BUCKET_CODE_FOR_STATUS,
  isOrderState,
  ORDER_STANDARD_V1,
  WORKFLOW_INVALID_TRANSITION,
  WORKFLOW_PARAM_INVALID,
  WORKFLOW_PARAM_REQUIRED,
  WORKFLOW_STATE_TERMINAL,
  WORKFLOW_UNKNOWN_COMMAND,
  type OrderPrimaryState,
  type OrderState,
} from "@pharmax/workflow";
import { z } from "zod";

import { REOPEN_REASONS, REOPEN_TARGET_STATES, type ReopenTargetState } from "../reopen-reasons.js";

export const ORDER_REOPEN_POLICY_UNSUPPORTED = "ORDER_REOPEN_POLICY_UNSUPPORTED";
export const ORDER_REOPEN_STATE_UNKNOWN = "ORDER_REOPEN_STATE_UNKNOWN";
export const ORDER_REOPEN_INVALID_FROM = "ORDER_REOPEN_INVALID_FROM";
export const ORDER_REOPEN_TERMINAL_STATE = "ORDER_REOPEN_TERMINAL_STATE";
export const ORDER_REOPEN_INVALID_TARGET = "ORDER_REOPEN_INVALID_TARGET";
export const ORDER_REOPEN_PARAM_REQUIRED = "ORDER_REOPEN_PARAM_REQUIRED";
export const ORDER_REOPEN_BUCKET_NOT_CONFIGURED = "ORDER_REOPEN_BUCKET_NOT_CONFIGURED";

const inputSchema = z
  .object({
    orderId: z.uuid(),
    reopenToState: z.enum(REOPEN_TARGET_STATES),
    reason: z.enum(REOPEN_REASONS),
    reasonText: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.reason !== ReopenReason.OTHER ||
      (typeof value.reasonText === "string" && value.reasonText.trim().length > 0),
    {
      message: "reasonText is required when reason === OTHER.",
      path: ["reasonText"],
    }
  );

export type ReopenForCorrectionInput = z.infer<typeof inputSchema>;

export interface ReopenForCorrectionOutput {
  readonly orderId: string;
  readonly correctionReopenId: string;
  readonly currentStatus: ReopenTargetState;
  readonly reopenedFromStatus: OrderState;
  readonly version: number;
  readonly transitionId: string;
}

function assigneeForReopenTarget(
  reopenToState: ReopenTargetState,
  actorUserId: string
): string | null {
  if (reopenToState === "TYPING_IN_PROGRESS" || reopenToState === "FILL_IN_PROGRESS") {
    return actorUserId;
  }
  return null;
}

export const ReopenForCorrection = defineCommand<
  ReopenForCorrectionInput,
  ReopenForCorrectionOutput
>({
  name: "ReopenForCorrection",
  inputSchema,
  permission: PERMISSIONS.ORDERS_REOPEN_FOR_CORRECTION,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  redactFields: ["reasonText"],

  async exec({ tx, ctx, input, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "REOPEN_FOR_CORRECTION_NO_TARGET",
        message: "Locked target was not provided to ReopenForCorrection handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "REOPEN_FOR_CORRECTION_NO_POLICY",
        message: "Workflow policy was not loaded for ReopenForCorrection.",
      });
    }

    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: ORDER_REOPEN_POLICY_UNSUPPORTED,
        message:
          "ReopenForCorrection handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: ORDER_REOPEN_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const fromState: OrderState = target.currentStatus;

    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState: fromState,
      command: "REOPEN_FOR_CORRECTION",
      reopenToState: input.reopenToState,
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_STATE_TERMINAL:
          throw new errors.ConflictError({
            code: ORDER_REOPEN_TERMINAL_STATE,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: fromState },
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.ConflictError({
            code: ORDER_REOPEN_INVALID_FROM,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: fromState },
          });
        case WORKFLOW_PARAM_REQUIRED:
          throw new errors.ConflictError({
            code: ORDER_REOPEN_PARAM_REQUIRED,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: fromState },
          });
        case WORKFLOW_PARAM_INVALID:
          throw new errors.ConflictError({
            code: ORDER_REOPEN_INVALID_TARGET,
            message: transition.reason,
            metadata: {
              orderId: target.id,
              currentStatus: fromState,
              reopenToState: input.reopenToState,
            },
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

    const bucketCode = BUCKET_CODE_FOR_STATUS[input.reopenToState as OrderPrimaryState];
    const bucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: bucketCode,
      },
      select: { id: true },
    });
    if (bucket === null) {
      throw new errors.InternalError({
        code: ORDER_REOPEN_BUCKET_NOT_CONFIGURED,
        message: `No ${bucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: bucketCode },
      });
    }

    const now = clock.now();
    const reasonText =
      typeof input.reasonText === "string" && input.reasonText.trim().length > 0
        ? input.reasonText
        : null;
    const hasReasonText = reasonText !== null;

    const reopenRecord = await tx.orderCorrectionReopen.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        reason: input.reason,
        reasonText,
        reopenedByUserId: ctx.actor.userId,
        reopenedFromStatus: fromState as OrderStatus,
        reopenToStatus: input.reopenToState as OrderStatus,
        reopenedAt: now,
        workflowPolicyId: policy.id,
        workflowPolicyVersion: policy.version,
        commandLogId,
      },
      select: { id: true },
    });

    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: input.reopenToState as OrderStatus,
        currentBucketId: bucket.id,
        currentAssigneeUserId: assigneeForReopenTarget(input.reopenToState, ctx.actor.userId),
      },
    });

    // ---- SLA: close WAIT_AFTER_*_REJECT + open reopen target ----
    //
    // Handler-direct (not in `COMMAND_STAGE_INTERVAL_TRANSITION`)
    // because the open kind is data-driven by `reopenToState`,
    // which is bounded by `REOPEN_TARGET_STATES`:
    //
    //   TYPING_IN_PROGRESS              → TYPING_ACTIVE
    //   TYPED_READY_FOR_PV1             → WAIT_BEFORE_PV1
    //   FILL_IN_PROGRESS                → FILL_ACTIVE
    //   FILL_COMPLETED_READY_FOR_FINAL  → WAIT_BEFORE_FINAL_VERIFICATION
    //
    // The close kind is derived from the source state — engine
    // already validated `fromState ∈ {PV1_REJECTED,
    // FINAL_VERIFICATION_REJECTED}`, so the map resolves the
    // close to `WAIT_AFTER_PV1_REJECT` or `WAIT_AFTER_FINAL_REJECT`.
    // A `null` from either lookup is a programmer error (the
    // engine accepted a state the SLA map doesn't recognize) —
    // surface InternalError instead of swallowing it.
    //
    // The reopener becomes the active actor when the reopen
    // target is an ACTIVE interval (TYPING/FILL_ACTIVE — the
    // same operator who clicked "Reopen for correction" is
    // actively reworking the order, mirrored on
    // `currentAssigneeUserId` above). For WAIT_* reopen targets
    // (TYPED_READY_FOR_PV1, FILL_COMPLETED_READY_FOR_FINAL) the
    // SLA primitive forces actor to null per the schema invariant.
    const closeKind = intervalKindForOrderState(fromState);
    const openKind = intervalKindForOrderState(input.reopenToState);
    if (closeKind === null || openKind === null) {
      throw new errors.InternalError({
        code: "REOPEN_FOR_CORRECTION_SLA_MAP_DRIFT",
        message:
          "ReopenForCorrection encountered a state without an SLA interval-kind mapping. " +
          "Workflow policy and stage-interval-state-map are out of sync.",
        metadata: {
          orderId: target.id,
          fromState,
          reopenToState: input.reopenToState,
          closeKind,
          openKind,
        },
      });
    }
    await closeOpenStageInterval({
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      endedAt: now,
      commandLogId,
      expectedKind: closeKind,
    });
    await openStageInterval({
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      siteId: target.siteId,
      kind: openKind,
      startedAt: now,
      commandLogId,
      actorUserId: isActiveIntervalKind(openKind) ? ctx.actor.userId : null,
    });

    const nextVersion = target.version + 1;

    return {
      output: {
        orderId: target.id,
        correctionReopenId: reopenRecord.id,
        currentStatus: input.reopenToState,
        reopenedFromStatus: fromState,
        version: nextVersion,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: nextVersion },
      audit: {
        action: "order.reopened",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          correctionReopenId: reopenRecord.id,
          fromState: transition.fromState,
          toState: transition.toState,
          reopenToState: input.reopenToState,
          transitionId: transition.transitionId,
          reason: input.reason,
          hasReasonText,
          reopenedByUserId: ctx.actor.userId,
          reopenedFromStatus: fromState,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          bucketIdAfter: bucket.id,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.reopened.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            correctionReopenId: reopenRecord.id,
            reason: input.reason,
            hasReasonText,
            reopenedByUserId: ctx.actor.userId,
            reopenedFromStatus: fromState,
            reopenToState: input.reopenToState,
            transitionId: transition.transitionId,
            bucketId: bucket.id,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});
