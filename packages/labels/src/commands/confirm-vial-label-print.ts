// Print-job completion callback from the workstation print agent.
//
// NAME NOTE: this command confirms EVERY label print job, not only
// patient vial labels — compound batch and unit labels flow through the
// same print agent, and it has exactly one callback. The name predates
// compound labels and is retained because the agent, its tests, and the
// command-log history all reference it; the permission behind it
// (`labels.confirm_print`) was always kind-agnostic. What varies by
// target is the event emitted, below.

import { defineCommand } from "@pharmax/command-bus";
import { PrintJobStatus, PrintJobTargetKind } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const PRINT_JOB_NOT_FOUND = "PRINT_JOB_NOT_FOUND";
export const PRINT_JOB_NOT_CONFIRMABLE = "PRINT_JOB_NOT_CONFIRMABLE";

const CONFIRMABLE_STATUSES = ["COMPLETED", "FAILED"] as const;

const inputSchema = z
  .object({
    printJobId: z.uuid(),
    status: z.enum(CONFIRMABLE_STATUSES),
    failureReason: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "FAILED" && value.failureReason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "failureReason is required when status is FAILED",
        path: ["failureReason"],
      });
    }
    if (value.status === "COMPLETED" && value.failureReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "failureReason must be omitted when status is COMPLETED",
        path: ["failureReason"],
      });
    }
  });

export type ConfirmVialLabelPrintInput = z.infer<typeof inputSchema>;

export interface ConfirmVialLabelPrintOutput {
  readonly printJobId: string;
  readonly status: (typeof CONFIRMABLE_STATUSES)[number];
}

export const ConfirmVialLabelPrint = defineCommand<
  ConfirmVialLabelPrintInput,
  ConfirmVialLabelPrintOutput
>({
  name: "ConfirmVialLabelPrint",
  inputSchema,
  permission: PERMISSIONS.LABELS_CONFIRM_PRINT,
  requiresWorkstation: true,
  redactFields: [],

  async exec({ tx, ctx, input, clock }) {
    const printJob = await tx.printJob.findFirst({
      where: { id: input.printJobId, organizationId: ctx.organizationId },
      select: {
        id: true,
        status: true,
        targetKind: true,
        orderId: true,
        orderLineId: true,
        compoundBatchId: true,
        compoundBatchUnitId: true,
        workstationId: true,
      },
    });

    if (printJob === null) {
      throw new errors.NotFoundError({
        code: PRINT_JOB_NOT_FOUND,
        message: "Print job not found.",
        metadata: { printJobId: input.printJobId },
      });
    }

    if (printJob.status !== PrintJobStatus.PENDING && printJob.status !== PrintJobStatus.SENT) {
      throw new errors.ConflictError({
        code: PRINT_JOB_NOT_CONFIRMABLE,
        message: "Print job is not in a confirmable state.",
        metadata: { printJobId: printJob.id, status: printJob.status },
      });
    }

    if (
      printJob.workstationId !== undefined &&
      printJob.workstationId !== null &&
      ctx.workstationId !== undefined &&
      printJob.workstationId !== ctx.workstationId
    ) {
      throw new errors.AuthorizationError({
        code: "WORKSTATION_MISMATCH",
        message: "Print job belongs to a different workstation.",
        metadata: {
          printJobId: printJob.id,
          expectedWorkstationId: printJob.workstationId,
          actualWorkstationId: ctx.workstationId,
        },
      });
    }

    const now = clock.now();

    await tx.printJob.update({
      where: { id: printJob.id },
      data: {
        status: input.status,
        failureReason:
          input.status === PrintJobStatus.FAILED ? (input.failureReason ?? null) : null,
        completedAt: now,
      },
    });

    const completed = input.status === PrintJobStatus.COMPLETED;
    // Tested positively rather than as `!== ORDER_LINE` so an
    // unrecognized or absent target falls back to the order-scoped
    // branch — the long-standing path — instead of being reported as a
    // compound label it is not.
    const isCompoundLabel =
      printJob.targetKind === PrintJobTargetKind.COMPOUND_BATCH ||
      printJob.targetKind === PrintJobTargetKind.COMPOUND_UNIT;

    // Two event families, not one widened family. The vial events
    // declare orderId/orderLineId as required UUIDs and the patient
    // path depends on that; a compound batch has neither, and an event
    // carrying `orderId: null` would be a worse description of a batch
    // label than one carrying `compoundBatchId`.
    const emit = isCompoundLabel
      ? {
          eventType: completed
            ? "labels.compound_label.completed.v1"
            : "labels.compound_label.failed.v1",
          aggregateType: "PrintJob",
          aggregateId: printJob.id,
          payload: {
            printJobId: printJob.id,
            organizationId: ctx.organizationId,
            targetKind: printJob.targetKind,
            compoundBatchId: printJob.compoundBatchId,
            ...(printJob.compoundBatchUnitId === null
              ? {}
              : { compoundBatchUnitId: printJob.compoundBatchUnitId }),
            status: input.status,
            workstationId: ctx.workstationId ?? null,
            occurredAt: now.toISOString(),
          },
        }
      : {
          eventType: completed ? "labels.vial_print.completed.v1" : "labels.vial_print.failed.v1",
          aggregateType: "PrintJob",
          aggregateId: printJob.id,
          payload: {
            printJobId: printJob.id,
            organizationId: ctx.organizationId,
            orderId: printJob.orderId,
            orderLineId: printJob.orderLineId,
            status: input.status,
            workstationId: ctx.workstationId ?? null,
            occurredAt: now.toISOString(),
          },
        };

    return {
      output: { printJobId: printJob.id, status: input.status },
      // Only an order-scoped job has an order timeline to append to.
      ...(printJob.orderId === null ? {} : { targetOrderId: printJob.orderId }),
      audit: {
        action: isCompoundLabel ? "labels.compound_label.confirmed" : "labels.vial_print.confirmed",
        resourceType: "PrintJob",
        resourceId: printJob.id,
        metadata: {
          printJobId: printJob.id,
          targetKind: printJob.targetKind,
          orderId: printJob.orderId,
          orderLineId: printJob.orderLineId,
          compoundBatchId: printJob.compoundBatchId,
          compoundBatchUnitId: printJob.compoundBatchUnitId,
          status: input.status,
          workstationId: ctx.workstationId ?? null,
          hasFailureReason: input.failureReason !== undefined,
        },
      },
      emits: [emit],
    };
  },
});
