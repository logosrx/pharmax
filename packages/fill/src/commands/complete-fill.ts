import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { PARTIAL_FILL_BASES, type PartialFillBasis } from "@pharmax/controlled-substances";
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
  evaluateFillDispensing,
  FILL_CONTROLLED_SUBSTANCE_NOT_PERMITTED,
  FILL_PARTIAL_FILL_BASIS_REQUIRED,
  FILL_PARTIAL_FILL_BASIS_UNEXPECTED,
  type DispensingLine,
} from "../controlled-substance-dispensing.js";
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
  FILL_CONTROLLED_SUBSTANCE_NOT_PERMITTED,
  FILL_PARTIAL_FILL_BASIS_REQUIRED,
  FILL_PARTIAL_FILL_BASIS_UNEXPECTED,
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

// Partial-fill declarations are kept OUT of `lineScans` on purpose: a
// scan is physical verification that the right thing is in the hand,
// whereas a partial-fill basis is a regulatory assertion about how much
// is being supplied and under which paragraph of 21 CFR 1306. Folding
// them together would invite treating one as evidence for the other.
const partialFillSchema = z
  .object({
    orderLineId: z.uuid(),
    basis: z.enum(PARTIAL_FILL_BASES),
  })
  .strict();

const inputSchema = z
  .object({
    orderId: z.uuid(),
    lineScans: z.array(lineScanSchema).min(1),
    /** Only meaningful for controlled-substance lines. */
    partialFills: z.array(partialFillSchema).optional(),
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
        clinicId: true,
        lotId: true,
        vialLabelId: true,
        quantityToFill: true,
        prescriptionId: true,
        // Part 1306 facts (ADR-0037). The schedule is the SNAPSHOT
        // taken at issuance, not the catalog's current value —
        // rescheduling a substance must not retroactively change the
        // rules that governed an already-written prescription.
        prescription: {
          select: {
            controlledSubstanceSchedule: true,
            originalDateWritten: true,
            refillsAuthorized: true,
            quantityAuthorized: true,
            earliestFillDate: true,
          },
        },
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

    // ---- 21 CFR part 1306 dispensing rules (ADR-0037) -------------
    //
    // Evaluated BEFORE the scan and label checks: if a controlled
    // substance may not lawfully be dispensed today, no amount of
    // rescanning or reprinting changes that, and telling the
    // pharmacist to fix a label first would waste the bench time.
    const dispensingLines: DispensingLine[] = lines.map((line) => ({
      orderLineId: line.id,
      clinicId: line.clinicId,
      quantityToFill: line.quantityToFill.toNumber(),
      prescriptionId: line.prescriptionId,
      prescription: {
        schedule: line.prescription.controlledSubstanceSchedule,
        originalDateWritten: line.prescription.originalDateWritten,
        refillsAuthorized: line.prescription.refillsAuthorized,
        quantityAuthorized: line.prescription.quantityAuthorized.toNumber(),
        earliestFillDate: line.prescription.earliestFillDate,
      },
    }));

    const declaredBases = new Map<string, PartialFillBasis>(
      (input.partialFills ?? []).map((declaration) => [declaration.orderLineId, declaration.basis])
    );

    const dispensingRows = await evaluateFillDispensing({
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      lines: dispensingLines,
      declaredBases,
      now,
    });

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

    // ---- 21 CFR 1304 dispensing ledger ----------------------------
    //
    // Written in the same transaction that completes the fill, so the
    // record of a controlled substance leaving the building cannot
    // diverge from the workflow state that says it did.
    //
    // `skipDuplicates` covers re-completion after rework: the unique
    // on `orderLineId` means the line already has its row, and the
    // drug was still dispensed only once. Inserting again would
    // fabricate a refill that never happened.
    if (dispensingRows.length > 0) {
      await tx.controlledSubstanceDispensing.createMany({
        skipDuplicates: true,
        data: dispensingRows.map((row) => ({
          organizationId: ctx.organizationId,
          clinicId: row.clinicId,
          prescriptionId: row.prescriptionId,
          orderId: target.id,
          orderLineId: row.orderLineId,
          schedule: row.schedule,
          fillNumber: row.fillNumber,
          quantityDispensed: row.quantityDispensed,
          partialFillBasis: row.partialFillBasis,
          dispensedAt: now,
          dispensedByUserId: ctx.actor.userId,
          commandLogId,
        })),
      });
    }

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
          // 21 CFR 1304: which controlled substances this fill
          // dispensed, and under what fill ordinal. Ids and schedules
          // only — no patient identity.
          controlledSubstanceDispensings: dispensingRows.map((row) => ({
            orderLineId: row.orderLineId,
            prescriptionId: row.prescriptionId,
            schedule: row.schedule,
            fillNumber: row.fillNumber,
            partialFillBasis: row.partialFillBasis,
          })),
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
