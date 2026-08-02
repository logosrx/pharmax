import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { CompoundingQualityOutcome, OrderStatus, PrintJobStatus } from "@pharmax/database";
import {
  FILL_SCAN_COMPOUND_LOT_UNEXPECTED,
  FILL_SCAN_DUPLICATE_LINE,
  FILL_SCAN_LINE_COUNT_MISMATCH,
  FILL_SCAN_LOT_MISMATCH,
  FILL_SCAN_LOT_SCAN_REQUIRED,
  FILL_SCAN_NDC_MISMATCH,
  FILL_SCAN_PARSE_FAILED,
  FILL_SCAN_UNKNOWN_LINE,
  FILL_SCAN_VIAL_LABEL_MISMATCH,
  validateFillCompletionScans,
  type FillLineScanExpectation,
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
// Compound-line guards (ADR-0035 slice 4): a patient-specific prep
// has no finished-goods lot — the latest compounding record for the
// line is its physical-verification anchor.
export const FILL_COMPOUND_QUALITY_FAILED = "FILL_COMPOUND_QUALITY_FAILED";
export const FILL_COMPOUND_BUD_EXPIRED = "FILL_COMPOUND_BUD_EXPIRED";

export {
  FILL_SCAN_COMPOUND_LOT_UNEXPECTED,
  FILL_SCAN_DUPLICATE_LINE,
  FILL_SCAN_LINE_COUNT_MISMATCH,
  FILL_SCAN_LOT_MISMATCH,
  FILL_SCAN_LOT_SCAN_REQUIRED,
  FILL_SCAN_NDC_MISMATCH,
  FILL_SCAN_PARSE_FAILED,
  FILL_SCAN_UNKNOWN_LINE,
  FILL_SCAN_VIAL_LABEL_MISMATCH,
};

const lineScanSchema = z
  .object({
    orderLineId: z.uuid(),
    // Required for stock lines, forbidden for compound-prep lines —
    // enforced against the loaded lines in the handler, where the
    // line kind is known.
    lotScan: z.string().trim().min(1).max(500).optional(),
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
        // The ACTIVE print job for the line's vial label. Fill
        // completion must verify THIS job completed — not any
        // historical completed job — otherwise a requested reprint
        // (damaged label) that is still pending/failed would pass on
        // the stale earlier print and the vial could move on without
        // a usable physical label.
        vialLabel: {
          select: {
            activePrintJob: { select: { id: true, status: true } },
          },
        },
        lot: {
          select: {
            lotNumber: true,
            product: { select: { ndc: true } },
          },
        },
        // The LATEST compounding record for the line (ADR-0035
        // slice 4). When no lot is assigned, this record is the
        // line's physical-verification anchor: latest wins, so a
        // FAIL → re-prep PASS completes and a PASS → FAIL re-check
        // blocks.
        compoundingRecords: {
          orderBy: { preparedAt: "desc" },
          take: 1,
          select: {
            id: true,
            qualityOutcome: true,
            budAt: true,
            formulaCode: true,
            formulaVersion: true,
          },
        },
      },
    });

    const now = clock.now();

    // ---- Per-line kind resolution + compound-prep guards ----------
    //
    // A line with an assigned lot always follows the stock rules —
    // batch-prepared compounds keep their finished-goods lot path.
    // A line without a lot is a compound-prep line only when a
    // compounding record exists; otherwise the classic "assign a lot
    // first" conflict stands.
    const expectations: FillLineScanExpectation[] = lines.map((line) => {
      if (line.lot !== null) {
        return {
          orderLineId: line.id,
          kind: "STOCK" as const,
          expectedLotNumber: line.lot.lotNumber,
          expectedNdc: line.lot.product.ndc,
        };
      }

      const latestRecord = line.compoundingRecords[0];
      if (latestRecord === undefined) {
        throw new errors.ConflictError({
          code: FILL_LOT_NOT_ASSIGNED,
          message:
            "Every order line must have an assigned lot — or a recorded compounding preparation — before completing fill.",
          metadata: { orderId: target.id, orderLineId: line.id },
        });
      }
      if (latestRecord.qualityOutcome !== CompoundingQualityOutcome.PASS) {
        throw new errors.ConflictError({
          code: FILL_COMPOUND_QUALITY_FAILED,
          message:
            "The latest compounding record for this line is a quality FAIL. Re-prepare and record a passing preparation before completing fill.",
          metadata: {
            orderId: target.id,
            orderLineId: line.id,
            compoundingRecordId: latestRecord.id,
            formulaCode: latestRecord.formulaCode,
            formulaVersion: latestRecord.formulaVersion,
          },
        });
      }
      // The prep-side mirror of "no expired lot assignment": a
      // preparation past its beyond-use date cannot ship.
      if (latestRecord.budAt.getTime() <= now.getTime()) {
        throw new errors.ConflictError({
          code: FILL_COMPOUND_BUD_EXPIRED,
          message:
            "The compounded preparation for this line is past its beyond-use date. Re-prepare before completing fill.",
          metadata: {
            orderId: target.id,
            orderLineId: line.id,
            compoundingRecordId: latestRecord.id,
            budAt: latestRecord.budAt.toISOString(),
          },
        });
      }
      return { orderLineId: line.id, kind: "COMPOUND" as const };
    });

    const scanValidation = validateFillCompletionScans({
      expectations,
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
      if (line.vialLabelId === null || line.vialLabel === null) {
        throw new errors.ConflictError({
          code: FILL_LABEL_PRINT_NOT_COMPLETE,
          message: "Every order line must have a printed vial label before completing fill.",
          metadata: { orderId: target.id, orderLineId: line.id },
        });
      }

      // The label's ACTIVE print job (the most recent print or
      // reprint) must itself be COMPLETED. Accepting any historical
      // completed job let a pending/failed reprint slip through on
      // stale evidence.
      const activePrintJob = line.vialLabel.activePrintJob;
      if (activePrintJob.status !== PrintJobStatus.COMPLETED) {
        throw new errors.ConflictError({
          code: FILL_LABEL_PRINT_NOT_COMPLETE,
          message:
            "The active vial label print for this line has not completed (a reprint may still be pending or failed). Complete the print before completing fill.",
          metadata: {
            orderId: target.id,
            orderLineId: line.id,
            activePrintJobId: activePrintJob.id,
            activePrintJobStatus: activePrintJob.status,
          },
        });
      }
    }

    const transition = applyTransition({
      // Merged per-tenant overlay snapshot when resolved (ADR-0019);
      // static base otherwise. See ApprovePV1 for rationale.
      policy: policy.merged?.merged ?? ORDER_STANDARD_V1,
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
          compoundLineCount: expectations.filter((e) => e.kind === "COMPOUND").length,
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
