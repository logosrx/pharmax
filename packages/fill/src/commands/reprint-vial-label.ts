import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { LabelStockKind, LabelPrinterStatus, PrintJobStatus } from "@pharmax/database";
import {
  DEFAULT_VIAL_TEMPLATE_CODE,
  hashZplContent,
  isVialLabelReprintReason,
  renderVialLabelZpl,
  VIAL_LABEL_REPRINT_REASONS,
} from "@pharmax/labels";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { assertFillAssignee, assertFillInProgressWithAssignee } from "../fill-guards.js";
import { loadVialLabelRenderContext } from "../load-vial-label-context.js";
import {
  PRINTER_INACTIVE,
  PRINTER_NOT_FOUND,
  PRINTER_NOT_THERMAL,
  PRINT_TEMPLATE_NOT_FOUND,
} from "./print-vial-label.js";

export const VIAL_LABEL_NOT_FOUND = "VIAL_LABEL_NOT_FOUND";

const inputSchema = z
  .object({
    orderId: z.uuid(),
    orderLineId: z.uuid(),
    printerId: z.uuid(),
    reprintReasonCode: z.enum(VIAL_LABEL_REPRINT_REASONS),
    templateCode: z.string().min(1).max(64).default(DEFAULT_VIAL_TEMPLATE_CODE),
  })
  .strict();

export type ReprintVialLabelInput = z.infer<typeof inputSchema>;

export interface ReprintVialLabelOutput {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly printJobId: string;
  readonly vialLabelId: string;
  readonly reprintReasonCode: string;
  readonly contentHashHex: string;
  readonly version: number;
}

export const ReprintVialLabel = defineCommand<ReprintVialLabelInput, ReprintVialLabelOutput>({
  name: "ReprintVialLabel",
  inputSchema,
  permission: PERMISSIONS.FILL_REPRINT_VIAL_LABEL,
  requiresWorkstation: true,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  redactFields: [],

  async exec({ tx, ctx, input, target, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "REPRINT_VIAL_LABEL_NO_TARGET",
        message: "Locked order target was not provided to ReprintVialLabel.",
      });
    }

    if (!isVialLabelReprintReason(input.reprintReasonCode)) {
      throw new errors.ValidationError({
        code: "COMMAND_INPUT_INVALID",
        message: "Invalid vial label reprint reason code.",
        metadata: { reprintReasonCode: input.reprintReasonCode },
      });
    }

    assertFillInProgressWithAssignee({ target, ctx });
    await assertFillAssignee({ tx, target, ctx });

    const vialLabel = await tx.vialLabel.findFirst({
      where: {
        organizationId: ctx.organizationId,
        orderLineId: input.orderLineId,
        orderId: target.id,
      },
      select: { id: true },
    });
    if (vialLabel === null) {
      throw new errors.NotFoundError({
        code: VIAL_LABEL_NOT_FOUND,
        message: "No vial label exists for this order line.",
        metadata: { orderLineId: input.orderLineId },
      });
    }

    const printer = await tx.labelPrinter.findFirst({
      where: { id: input.printerId, organizationId: ctx.organizationId },
      select: {
        id: true,
        siteId: true,
        labelStock: true,
        status: true,
        vendor: true,
        protocol: true,
      },
    });
    if (printer === null || printer.siteId !== target.siteId) {
      throw new errors.NotFoundError({
        code: PRINTER_NOT_FOUND,
        message: "Label printer not found for this site.",
        metadata: { printerId: input.printerId },
      });
    }
    if (printer.status !== LabelPrinterStatus.ACTIVE) {
      throw new errors.ConflictError({
        code: PRINTER_INACTIVE,
        message: "Label printer is not active.",
        metadata: { printerId: printer.id },
      });
    }
    if (printer.labelStock !== LabelStockKind.VIAL) {
      throw new errors.ConflictError({
        code: PRINTER_NOT_THERMAL,
        message: "Only vial thermal label printers may print vial labels.",
        metadata: { printerId: printer.id },
      });
    }

    const template = await tx.printTemplate.findFirst({
      where: {
        organizationId: ctx.organizationId,
        code: input.templateCode,
        labelStock: LabelStockKind.VIAL,
        isActive: true,
      },
      orderBy: { version: "desc" },
      select: { id: true, version: true, zplBody: true },
    });
    if (template === null) {
      throw new errors.NotFoundError({
        code: PRINT_TEMPLATE_NOT_FOUND,
        message: "Active vial print template not found.",
        metadata: { templateCode: input.templateCode },
      });
    }

    const renderInput = await loadVialLabelRenderContext({
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      orderLineId: input.orderLineId,
    });
    const renderedZpl = renderVialLabelZpl(template.zplBody, renderInput);
    const contentHash = hashZplContent(renderedZpl);

    const printJob = await tx.printJob.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        orderLineId: input.orderLineId,
        printerId: printer.id,
        workstationId: ctx.workstationId ?? null,
        printTemplateId: template.id,
        printTemplateVersion: template.version,
        status: PrintJobStatus.PENDING,
        renderedZpl,
        // Prisma 7 `Bytes` write inputs are `Uint8Array<ArrayBuffer>`;
        // copy the (ArrayBufferLike-backed) hash Buffer into one.
        contentHash: new Uint8Array(contentHash),
        isReprint: true,
        reprintReasonCode: input.reprintReasonCode,
        requestedByUserId: ctx.actor.userId,
        commandLogId,
      },
      select: { id: true },
    });

    await tx.vialLabel.update({
      where: { id: vialLabel.id },
      data: { activePrintJobId: printJob.id },
    });

    const fromVersion = target.version;
    const toVersion = target.version + 1;
    const now = clock.now();

    return {
      output: {
        orderId: target.id,
        orderLineId: input.orderLineId,
        printJobId: printJob.id,
        vialLabelId: vialLabel.id,
        reprintReasonCode: input.reprintReasonCode,
        contentHashHex: contentHash.toString("hex"),
        version: toVersion,
      },
      targetOrderId: target.id,
      bumpVersion: { from: fromVersion, to: toVersion },
      audit: {
        action: "fill.vial_label.reprint_requested",
        resourceType: "PrintJob",
        resourceId: printJob.id,
        metadata: {
          orderId: target.id,
          orderLineId: input.orderLineId,
          printJobId: printJob.id,
          vialLabelId: vialLabel.id,
          reprintReasonCode: input.reprintReasonCode,
          printerId: printer.id,
          templateCode: input.templateCode,
          templateVersion: template.version,
          contentHashHex: contentHash.toString("hex"),
          workstationId: ctx.workstationId ?? null,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "labels.vial_print.reprint_requested.v1",
          aggregateType: "PrintJob",
          aggregateId: printJob.id,
          payload: {
            organizationId: ctx.organizationId,
            orderId: target.id,
            orderLineId: input.orderLineId,
            printJobId: printJob.id,
            vialLabelId: vialLabel.id,
            reprintReasonCode: input.reprintReasonCode,
            printerId: printer.id,
            workstationId: ctx.workstationId ?? null,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

export { ORDER_VERSION_MISMATCH };
