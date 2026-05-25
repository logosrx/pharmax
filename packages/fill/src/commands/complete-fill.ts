import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { OrderStatus, PrintJobStatus } from "@pharmax/database";
import {
  FILL_SCAN_DUPLICATE_LINE,
  FILL_SCAN_LINE_COUNT_MISMATCH,
  FILL_SCAN_LOT_MISMATCH,
  FILL_SCAN_NDC_MISMATCH,
  FILL_SCAN_PARSE_FAILED,
  FILL_SCAN_UNKNOWN_LINE,
  FILL_SCAN_VIAL_LABEL_MISMATCH,
  validateFillCompletionScans,
} from "@pharmax/scan";
import { FINAL_BUCKET_NOT_CONFIGURED } from "@pharmax/verification";
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
  assertFillAssignee,
  assertFillInProgressWithAssignee,
  FILL_INVALID_TRANSITION,
  FILL_ORDER_STATE_UNKNOWN,
  FILL_ORDER_TERMINAL,
  FILL_POLICY_UNSUPPORTED,
} from "../fill-guards.js";

export const FILL_LOT_NOT_ASSIGNED = "FILL_LOT_NOT_ASSIGNED";
export const FILL_LABEL_PRINT_NOT_COMPLETE = "FILL_LABEL_PRINT_NOT_COMPLETE";

export {
  FILL_SCAN_DUPLICATE_LINE,
  FILL_SCAN_LINE_COUNT_MISMATCH,
  FILL_SCAN_LOT_MISMATCH,
  FILL_SCAN_NDC_MISMATCH,
  FILL_SCAN_PARSE_FAILED,
  FILL_SCAN_UNKNOWN_LINE,
  FILL_SCAN_VIAL_LABEL_MISMATCH,
};

const lineScanSchema = z
  .object({
    orderLineId: z.uuid(),
    lotScan: z.string().trim().min(1).max(500),
    vialLabelScan: z.string().trim().min(1).max(500),
  })
  .strict();

const inputSchema = z
  .object({
    orderId: z.uuid(),
    lineScans: z.array(lineScanSchema).min(1),
  })
  .strict();

export type CompleteFillInput = z.infer<typeof inputSchema>;

export interface CompleteFillOutput {
  readonly orderId: string;
  readonly currentStatus: "FILL_COMPLETED_READY_FOR_FINAL";
  readonly version: number;
  readonly transitionId: string;
}

export const CompleteFill = defineCommand<CompleteFillInput, CompleteFillOutput>({
  name: "CompleteFill",
  inputSchema,
  permission: PERMISSIONS.FILL_COMPLETE,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  loadPolicy: { from: "target" },
  redactFields: [],

  async exec({ tx, ctx, target, policy, clock, commandLogId, input }) {
    if (target === undefined || policy === undefined) {
      throw new errors.InternalError({
        code: "COMPLETE_FILL_INTERNAL",
        message: "CompleteFill missing locked target or policy.",
      });
    }

    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: FILL_POLICY_UNSUPPORTED,
        message: "CompleteFill handler is wired only for order.standard v1.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    assertFillInProgressWithAssignee({ target, ctx });
    await assertFillAssignee({ tx, target, ctx });

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: FILL_ORDER_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const currentState: OrderState = target.currentStatus;

    const lines = await tx.orderLine.findMany({
      where: { orderId: target.id, organizationId: ctx.organizationId },
      select: {
        id: true,
        lotId: true,
        vialLabelId: true,
        lot: {
          select: {
            lotNumber: true,
            product: { select: { ndc: true } },
          },
        },
      },
    });

    const scanValidation = validateFillCompletionScans({
      expectations: lines.map((line) => {
        if (line.lot === null) {
          throw new errors.ConflictError({
            code: FILL_LOT_NOT_ASSIGNED,
            message: "Every order line must have an assigned lot before completing fill.",
            metadata: { orderId: target.id, orderLineId: line.id },
          });
        }
        return {
          orderLineId: line.id,
          expectedLotNumber: line.lot.lotNumber,
          expectedNdc: line.lot.product.ndc,
        };
      }),
      lineScans: input.lineScans,
    });

    if (scanValidation.result !== "SUCCESS") {
      throw new errors.ConflictError({
        code: scanValidation.code,
        message: scanValidation.message,
        metadata: scanValidation.metadata,
      });
    }

    for (const line of lines) {
      if (line.lotId === null) {
        throw new errors.ConflictError({
          code: FILL_LOT_NOT_ASSIGNED,
          message: "Every order line must have an assigned lot before completing fill.",
          metadata: { orderId: target.id, orderLineId: line.id },
        });
      }
      if (line.vialLabelId === null) {
        throw new errors.ConflictError({
          code: FILL_LABEL_PRINT_NOT_COMPLETE,
          message: "Every order line must have a printed vial label before completing fill.",
          metadata: { orderId: target.id, orderLineId: line.id },
        });
      }

      const completedPrint = await tx.printJob.findFirst({
        where: {
          organizationId: ctx.organizationId,
          orderLineId: line.id,
          status: PrintJobStatus.COMPLETED,
        },
        select: { id: true },
      });
      if (completedPrint === null) {
        throw new errors.ConflictError({
          code: FILL_LABEL_PRINT_NOT_COMPLETE,
          message:
            "Every order line must have a completed thermal print job before completing fill.",
          metadata: { orderId: target.id, orderLineId: line.id },
        });
      }
    }

    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState,
      command: "COMPLETE_FILL",
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

    const finalBucketCode = BUCKET_CODE_FOR_STATUS.FILL_COMPLETED_READY_FOR_FINAL;
    const finalBucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: finalBucketCode,
      },
      select: { id: true },
    });
    if (finalBucket === null) {
      throw new errors.InternalError({
        code: FINAL_BUCKET_NOT_CONFIGURED,
        message: `No ${finalBucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: finalBucketCode },
      });
    }

    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.FILL_COMPLETED_READY_FOR_FINAL,
        currentBucketId: finalBucket.id,
        currentAssigneeUserId: null,
      },
    });

    const now = clock.now();

    await applyCommandStageIntervalTransition({
      commandName: "CompleteFill",
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
        currentStatus: "FILL_COMPLETED_READY_FOR_FINAL" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.fill.completed",
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
          bucketIdAfter: finalBucket.id,
          fillTechUserId: ctx.actor.userId,
          lineCount: lines.length,
          scannedLineCount: input.lineScans.length,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.fill.completed.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            fillTechUserId: ctx.actor.userId,
            bucketId: finalBucket.id,
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
