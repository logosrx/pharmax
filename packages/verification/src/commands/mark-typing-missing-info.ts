// MarkTypingMissingInfo — the typist pauses typing on an order
// because something is blocking the transcription (prescriber
// callback needed, illegible Rx, missing field, etc.).
//
// Why this is a DIFFERENT shape from CompleteTypingReview:
//
//   CompleteTypingReview transitions TYPING_IN_PROGRESS →
//   TYPED_READY_FOR_PV1 (a primary-state forward move).
//   MarkTypingMissingInfo transitions TYPING_IN_PROGRESS →
//   TYPING_PENDING_MISSING_INFO (an EXCEPTION state that parks
//   the order in the TYPING bucket as a "waiting on external"
//   row). ResumeTyping is the symmetric undo (TYPING_PENDING_MISSING_INFO
//   → TYPING_IN_PROGRESS) when the info comes back.
//
// Assignee handling:
//   The pausing typist's assignment is CLEARED (`null`). Multiple
//   typists may share a queue; the original typist might be off-
//   shift when the info comes back. The historical "pausing typist"
//   identity is preserved on `audit_log.metadata.pausingTypistUserId`
//   and on `order_event.actorUserId` so reports can still attribute
//   the pause to the right person.
//
// Reason code:
//   `reasonCode` is required and validated against `MISSING_INFO_REASONS`
//   at the Zod boundary. Closed enum keeps the reason queryable
//   for ops reports ("what % of typing pauses are prescriber-
//   callback this month?") without joining a free-text column.
//
// SoD: no rule. A typist marking their own order as missing-info
// is the correct path (they're the one who discovered the
// blocker). Future SoD rules attached to TYPING_MARK_MISSING_INFO
// would land here as a `sodRules` clause.
//
// PHI: no PHI in input, audit metadata, or outbox payload.
// `reasonCode` is operational vocabulary, not PHI.

import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { OrderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { applyCommandStageIntervalTransition } from "@pharmax/sla";
import {
  applyTransition,
  BUCKET_CODE_FOR_EXCEPTION_STATE,
  ORDER_STANDARD_V1,
  WORKFLOW_INVALID_TRANSITION,
  WORKFLOW_STATE_TERMINAL,
  WORKFLOW_UNKNOWN_COMMAND,
  isOrderState,
  type OrderState,
} from "@pharmax/workflow";
import { z } from "zod";

import { MISSING_INFO_REASONS, type MissingInfoReason } from "../missing-info-reasons.js";
import {
  TYPING_BUCKET_NOT_CONFIGURED,
  TYPING_INVALID_TRANSITION,
  TYPING_ORDER_STATE_UNKNOWN,
  TYPING_ORDER_TERMINAL,
  TYPING_POLICY_UNSUPPORTED,
} from "./start-typing.js";

const inputSchema = z
  .object({
    orderId: z.uuid(),
    reasonCode: z.enum(MISSING_INFO_REASONS),
  })
  .strict();

export type MarkTypingMissingInfoInput = z.infer<typeof inputSchema>;

export interface MarkTypingMissingInfoOutput {
  readonly orderId: string;
  readonly currentStatus: "TYPING_PENDING_MISSING_INFO";
  readonly version: number;
  readonly transitionId: string;
  readonly reasonCode: MissingInfoReason;
}

export const MarkTypingMissingInfo = defineCommand<
  MarkTypingMissingInfoInput,
  MarkTypingMissingInfoOutput
>({
  name: "MarkTypingMissingInfo",
  inputSchema,
  permission: PERMISSIONS.TYPING_MARK_MISSING_INFO,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  redactFields: [],

  async exec({ tx, ctx, input, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "MARK_TYPING_MISSING_INFO_NO_TARGET",
        message: "Locked target was not provided to MarkTypingMissingInfo handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "MARK_TYPING_MISSING_INFO_NO_POLICY",
        message: "Workflow policy was not loaded for MarkTypingMissingInfo.",
      });
    }
    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: TYPING_POLICY_UNSUPPORTED,
        message:
          "MarkTypingMissingInfo handler is wired only for order.standard v1. " +
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

    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState,
      command: "MARK_TYPING_MISSING_INFO",
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

    // Destination bucket: TYPING_PENDING_MISSING_INFO → "TYPING"
    // via the exception-state map. Order stays in the typing
    // queue as an exception-styled row until ResumeTyping fires.
    const pauseBucketCode = BUCKET_CODE_FOR_EXCEPTION_STATE.TYPING_PENDING_MISSING_INFO;
    if (pauseBucketCode === undefined) {
      throw new errors.InternalError({
        code: "TYPING_PENDING_MISSING_INFO_BUCKET_MAPPING_MISSING",
        message:
          "TYPING_PENDING_MISSING_INFO has no entry in BUCKET_CODE_FOR_EXCEPTION_STATE; " +
          "the exception map and MarkTypingMissingInfo are out of sync.",
      });
    }
    const pauseBucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: pauseBucketCode,
      },
      select: { id: true },
    });
    if (pauseBucket === null) {
      throw new errors.InternalError({
        code: TYPING_BUCKET_NOT_CONFIGURED,
        message: `No ${pauseBucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: pauseBucketCode },
      });
    }

    const pausingTypistUserId = ctx.actor.userId;
    const now = clock.now();

    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.TYPING_PENDING_MISSING_INFO,
        currentBucketId: pauseBucket.id,
        currentAssigneeUserId: null,
      },
    });

    await applyCommandStageIntervalTransition({
      commandName: "MarkTypingMissingInfo",
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      siteId: target.siteId,
      at: now,
      commandLogId,
      actorUserId: pausingTypistUserId,
    });

    return {
      output: {
        orderId: target.id,
        currentStatus: "TYPING_PENDING_MISSING_INFO" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
        reasonCode: input.reasonCode,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.typing.missing_info",
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
          bucketIdAfter: pauseBucket.id,
          pausingTypistUserId,
          reasonCode: input.reasonCode,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.typing.missing_info.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            pausingTypistUserId,
            bucketId: pauseBucket.id,
            transitionId: transition.transitionId,
            fromState: transition.fromState,
            toState: transition.toState,
            reasonCode: input.reasonCode,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

export { ORDER_VERSION_MISMATCH };
