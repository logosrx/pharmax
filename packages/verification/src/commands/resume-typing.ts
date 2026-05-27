// ResumeTyping — the typist picks an order back up after the
// missing-info blocker is resolved.
//
// Symmetric to MarkTypingMissingInfo: closes the
// TYPING_PENDING_MISSING_INFO wait state and reopens
// TYPING_IN_PROGRESS with the resuming typist as the new
// assignee.
//
// The resuming typist DOES NOT have to be the same person who
// originally paused. Multiple typists share a queue; whoever
// notices "the prescriber called back" picks the order up. The
// audit captures `resumingTypistUserId`; the pause history is
// preserved in the earlier `order.typing.missing_info` audit row.
//
// Permission: `typing.start` — structurally the same action as
// claiming a RECEIVED order from the inbox (a typist beginning
// active work). Same permission grant, separate command name so
// the audit + outbox cleanly distinguish "fresh start" from
// "resume after pause".
//
// PHI: none. No PHI in input or audit metadata.

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
  TYPING_BUCKET_NOT_CONFIGURED,
  TYPING_INVALID_TRANSITION,
  TYPING_ORDER_STATE_UNKNOWN,
  TYPING_ORDER_TERMINAL,
  TYPING_POLICY_UNSUPPORTED,
} from "./start-typing.js";

const inputSchema = z
  .object({
    orderId: z.uuid(),
  })
  .strict();

export type ResumeTypingInput = z.infer<typeof inputSchema>;

export interface ResumeTypingOutput {
  readonly orderId: string;
  readonly currentStatus: "TYPING_IN_PROGRESS";
  readonly version: number;
  readonly transitionId: string;
}

export const ResumeTyping = defineCommand<ResumeTypingInput, ResumeTypingOutput>({
  name: "ResumeTyping",
  inputSchema,
  permission: PERMISSIONS.TYPING_START,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  redactFields: [],

  async exec({ tx, ctx, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "RESUME_TYPING_NO_TARGET",
        message: "Locked target was not provided to ResumeTyping handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "RESUME_TYPING_NO_POLICY",
        message: "Workflow policy was not loaded for ResumeTyping.",
      });
    }
    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: TYPING_POLICY_UNSUPPORTED,
        message:
          "ResumeTyping handler is wired only for order.standard v1. " +
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
      command: "RESUME_TYPING_AFTER_INFO_RECEIVED",
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

    const typingBucketCode = BUCKET_CODE_FOR_STATUS.TYPING_IN_PROGRESS;
    const typingBucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: typingBucketCode,
      },
      select: { id: true },
    });
    if (typingBucket === null) {
      throw new errors.InternalError({
        code: TYPING_BUCKET_NOT_CONFIGURED,
        message: `No ${typingBucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: typingBucketCode },
      });
    }

    const resumingTypistUserId = ctx.actor.userId;
    const now = clock.now();

    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.TYPING_IN_PROGRESS,
        currentBucketId: typingBucket.id,
        currentAssigneeUserId: resumingTypistUserId,
      },
    });

    await applyCommandStageIntervalTransition({
      commandName: "ResumeTyping",
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      siteId: target.siteId,
      at: now,
      commandLogId,
      actorUserId: resumingTypistUserId,
    });

    return {
      output: {
        orderId: target.id,
        currentStatus: "TYPING_IN_PROGRESS" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.typing.resumed",
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
          bucketIdAfter: typingBucket.id,
          resumingTypistUserId,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.typing.resumed.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            resumingTypistUserId,
            bucketId: typingBucket.id,
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
