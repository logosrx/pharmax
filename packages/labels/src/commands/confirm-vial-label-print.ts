import { defineCommand } from "@pharmax/command-bus";
import { PrintJobStatus } from "@pharmax/database";
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
        orderId: true,
        orderLineId: true,
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

    return {
      output: { printJobId: printJob.id, status: input.status },
      targetOrderId: printJob.orderId,
      audit: {
        action: "labels.vial_print.confirmed",
        resourceType: "PrintJob",
        resourceId: printJob.id,
        metadata: {
          printJobId: printJob.id,
          orderId: printJob.orderId,
          orderLineId: printJob.orderLineId,
          status: input.status,
          workstationId: ctx.workstationId ?? null,
          hasFailureReason: input.failureReason !== undefined,
        },
      },
      emits: [
        {
          eventType:
            input.status === PrintJobStatus.COMPLETED
              ? "labels.vial_print.completed.v1"
              : "labels.vial_print.failed.v1",
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
        },
      ],
    };
  },
});
