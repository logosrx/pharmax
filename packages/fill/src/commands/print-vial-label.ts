import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { LabelStockKind, LabelPrinterStatus, PrintJobStatus } from "@pharmax/database";
import { DEFAULT_VIAL_TEMPLATE_CODE, hashZplContent, renderVialLabelZpl } from "@pharmax/labels";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { assertFillAssignee, assertFillInProgressWithAssignee } from "../fill-guards.js";
import { loadVialLabelRenderContext } from "../load-vial-label-context.js";

export const PRINTER_NOT_FOUND = "PRINTER_NOT_FOUND";
export const PRINTER_NOT_THERMAL = "PRINTER_NOT_THERMAL";
export const PRINTER_INACTIVE = "PRINTER_INACTIVE";
export const PRINT_TEMPLATE_NOT_FOUND = "PRINT_TEMPLATE_NOT_FOUND";
export const VIAL_LABEL_ALREADY_EXISTS = "VIAL_LABEL_ALREADY_EXISTS";

const inputSchema = z
  .object({
    orderId: z.uuid(),
    orderLineId: z.uuid(),
    printerId: z.uuid(),
    templateCode: z.string().min(1).max(64).default(DEFAULT_VIAL_TEMPLATE_CODE),
  })
  .strict();

export type PrintVialLabelInput = z.infer<typeof inputSchema>;

export interface PrintVialLabelOutput {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly printJobId: string;
  readonly vialLabelId: string;
  readonly contentHashHex: string;
  readonly version: number;
}

export const PrintVialLabel = defineCommand<PrintVialLabelInput, PrintVialLabelOutput>({
  name: "PrintVialLabel",
  inputSchema,
  permission: PERMISSIONS.FILL_PRINT_VIAL_LABEL,
  requiresWorkstation: true,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  redactFields: [],

  async exec({ tx, ctx, input, target, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "PRINT_VIAL_LABEL_NO_TARGET",
        message: "Locked order target was not provided to PrintVialLabel.",
      });
    }

    assertFillInProgressWithAssignee({ target, ctx });
    await assertFillAssignee({ tx, target, ctx });

    const existingLabel = await tx.vialLabel.findFirst({
      where: {
        organizationId: ctx.organizationId,
        orderLineId: input.orderLineId,
      },
      select: { id: true },
    });
    if (existingLabel !== null) {
      throw new errors.ConflictError({
        code: VIAL_LABEL_ALREADY_EXISTS,
        message: "Vial label already exists for this order line. Use ReprintVialLabel.",
        metadata: { orderLineId: input.orderLineId, vialLabelId: existingLabel.id },
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
    if (printer === null) {
      throw new errors.NotFoundError({
        code: PRINTER_NOT_FOUND,
        message: "Label printer not found.",
        metadata: { printerId: input.printerId },
      });
    }
    if (printer.siteId !== target.siteId) {
      throw new errors.ConflictError({
        code: PRINTER_NOT_FOUND,
        message: "Label printer is not registered for this order site.",
        metadata: { printerId: printer.id, printerSiteId: printer.siteId },
      });
    }
    if (printer.status !== LabelPrinterStatus.ACTIVE) {
      throw new errors.ConflictError({
        code: PRINTER_INACTIVE,
        message: "Label printer is not active.",
        metadata: { printerId: printer.id, status: printer.status },
      });
    }
    if (printer.labelStock !== LabelStockKind.VIAL) {
      throw new errors.ConflictError({
        code: PRINTER_NOT_THERMAL,
        message: "Only vial thermal label printers may print vial labels.",
        metadata: { printerId: printer.id, labelStock: printer.labelStock },
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
        contentHash,
        isReprint: false,
        reprintReasonCode: null,
        requestedByUserId: ctx.actor.userId,
        commandLogId,
      },
      select: { id: true },
    });

    const vialLabel = await tx.vialLabel.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        orderLineId: input.orderLineId,
        barcodeValue: renderInput.barcodeValue,
        activePrintJobId: printJob.id,
      },
      select: { id: true },
    });

    await tx.orderLine.update({
      where: { id: input.orderLineId },
      data: { vialLabelId: vialLabel.id },
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
        contentHashHex: contentHash.toString("hex"),
        version: toVersion,
      },
      targetOrderId: target.id,
      bumpVersion: { from: fromVersion, to: toVersion },
      audit: {
        action: "fill.vial_label.print_requested",
        resourceType: "PrintJob",
        resourceId: printJob.id,
        metadata: {
          orderId: target.id,
          orderLineId: input.orderLineId,
          printJobId: printJob.id,
          vialLabelId: vialLabel.id,
          printerId: printer.id,
          printerVendor: printer.vendor,
          printerProtocol: printer.protocol,
          templateCode: input.templateCode,
          templateVersion: template.version,
          contentHashHex: contentHash.toString("hex"),
          workstationId: ctx.workstationId ?? null,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "labels.vial_print.requested.v1",
          aggregateType: "PrintJob",
          aggregateId: printJob.id,
          payload: {
            organizationId: ctx.organizationId,
            orderId: target.id,
            orderLineId: input.orderLineId,
            printJobId: printJob.id,
            vialLabelId: vialLabel.id,
            printerId: printer.id,
            workstationId: ctx.workstationId ?? null,
            templateCode: input.templateCode,
            templateVersion: template.version,
            contentHashHex: contentHash.toString("hex"),
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

export { ORDER_VERSION_MISMATCH };
