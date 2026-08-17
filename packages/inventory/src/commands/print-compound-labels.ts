// Compound stock label printing — batch labels and unit labels.
//
// These live in `@pharmax/inventory` rather than `@pharmax/fill`
// because they label STOCK, not a dispense. A compound batch exists
// before any patient order does; printing its labels is compounding-
// floor work in the inventory domain, and the `inventory -> labels`
// edge is registered in scripts/check-package-layers.ts for exactly
// this reason.
//
// One command per label kind, handling both the first print and every
// reprint. That is deliberate. The workflow rules require that every
// reprint carry a reason code and that no reprint be silent; a
// separate ReprintX command leaves the door open to calling PrintX
// twice and producing a second physical label with no reason
// recorded. Here the command COUNTS prior print jobs for the target
// and demands a reason code the moment that count is non-zero, so the
// rule is enforced by the data rather than by which endpoint the
// caller chose.
//
// PHI: none anywhere in this module. A batch has no patient by
// construction, which is what makes these labels safe to print in
// bulk to a stock-room printer.

import { defineCommand } from "@pharmax/command-bus";
import type { PrismaTxClient } from "@pharmax/command-bus";
import {
  CompoundBatchStatus,
  LabelPrinterStatus,
  LabelStockKind,
  PrintJobStatus,
  PrintJobTargetKind,
} from "@pharmax/database";
import {
  DEFAULT_COMPOUND_BATCH_TEMPLATE_CODE,
  DEFAULT_COMPOUND_UNIT_TEMPLATE_CODE,
  hashZplContent,
  isVialLabelReprintReason,
  renderCompoundBatchLabelZpl,
  renderCompoundUnitLabelZpl,
  VIAL_LABEL_REPRINT_REASONS,
} from "@pharmax/labels";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { currentTraceparent } from "@pharmax/telemetry";
import { z } from "zod";

import {
  BATCH_LABEL_PRINTER_INACTIVE,
  BATCH_LABEL_PRINTER_NOT_FOUND,
  BATCH_LABEL_PRINTER_WRONG_STOCK,
  BATCH_LABEL_REPRINT_REASON_REQUIRED,
  BATCH_LABEL_TEMPLATE_NOT_FOUND,
  BATCH_LABEL_UNIT_RANGE_INVALID,
  BATCH_LABEL_UNIT_RANGE_TOO_LARGE,
  BATCH_NOT_FOUND,
  BATCH_NOT_LABELABLE,
} from "../shared.js";

/**
 * Most units a single command may enqueue. A batch may hold thousands
 * of vials, and one command writing thousands of print-job rows (each
 * carrying rendered ZPL) plus thousands of outbox events would be a
 * transaction nobody wants to roll back. Operators print in runs; this
 * makes the run size explicit.
 */
export const COMPOUND_UNIT_LABEL_MAX_PER_COMMAND = 200;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Shared resolution
// ---------------------------------------------------------------------

interface BatchLabelContext {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly barcodeValue: string;
  readonly beyondUseDate: Date;
  readonly compoundedOn: Date;
  readonly unitCount: number;
  readonly status: CompoundBatchStatus;
  readonly siteId: string;
  readonly productName: string;
  readonly productStrength: string | null;
  readonly pharmaxProductId: string | null;
}

async function loadBatchForLabeling(
  tx: PrismaTxClient,
  organizationId: string,
  batchId: string
): Promise<BatchLabelContext> {
  const batch = await tx.compoundBatch.findFirst({
    where: { id: batchId, organizationId },
    select: {
      id: true,
      batchNumber: true,
      barcodeValue: true,
      beyondUseDate: true,
      compoundedOn: true,
      unitCount: true,
      status: true,
      siteId: true,
      product: { select: { name: true, strength: true, pharmaxProductId: true } },
    },
  });
  if (batch === null) {
    throw new errors.NotFoundError({
      code: BATCH_NOT_FOUND,
      message: "Compound batch not found in this organization.",
      metadata: { batchId },
    });
  }

  // A rejected batch must never acquire fresh labels. Its vials are
  // quarantine stock; a crisp new label is precisely how rejected
  // product gets mistaken for released product on a shelf.
  if (batch.status === CompoundBatchStatus.REJECTED) {
    throw new errors.ConflictError({
      code: BATCH_NOT_LABELABLE,
      message:
        "This batch was rejected by the testing lab; its labels cannot be printed or reprinted.",
      metadata: { batchId, batchNumber: batch.batchNumber, status: batch.status },
    });
  }

  if (batch.product.pharmaxProductId === null) {
    throw new errors.InternalError({
      code: BATCH_NOT_LABELABLE,
      message: "This batch's product has no Pharmax Product ID; the label cannot be rendered.",
      metadata: { batchId },
    });
  }

  return {
    batchId: batch.id,
    batchNumber: batch.batchNumber,
    barcodeValue: batch.barcodeValue,
    beyondUseDate: batch.beyondUseDate,
    compoundedOn: batch.compoundedOn,
    unitCount: batch.unitCount,
    status: batch.status,
    siteId: batch.siteId,
    productName: batch.product.name,
    productStrength: batch.product.strength,
    pharmaxProductId: batch.product.pharmaxProductId,
  };
}

interface ResolvedPrintTarget {
  readonly printerId: string;
  readonly printerVendor: string;
  readonly printerProtocol: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly zplBody: string;
}

async function resolvePrinterAndTemplate(args: {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly printerId: string;
  readonly batchSiteId: string;
  readonly labelStock: LabelStockKind;
  readonly templateCode: string;
}): Promise<ResolvedPrintTarget> {
  const printer = await args.tx.labelPrinter.findFirst({
    where: { id: args.printerId, organizationId: args.organizationId },
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
      code: BATCH_LABEL_PRINTER_NOT_FOUND,
      message: "Label printer not found in this organization.",
      metadata: { printerId: args.printerId },
    });
  }
  // The batch's site, not the actor's: labels for stock compounded at
  // one site must not print at another site's bench.
  if (printer.siteId !== args.batchSiteId) {
    throw new errors.ConflictError({
      code: BATCH_LABEL_PRINTER_NOT_FOUND,
      message: "Label printer is not registered at the site that compounded this batch.",
      metadata: { printerId: printer.id, printerSiteId: printer.siteId },
    });
  }
  if (printer.status !== LabelPrinterStatus.ACTIVE) {
    throw new errors.ConflictError({
      code: BATCH_LABEL_PRINTER_INACTIVE,
      message: "Label printer is not active.",
      metadata: { printerId: printer.id, status: printer.status },
    });
  }
  if (printer.labelStock !== args.labelStock) {
    throw new errors.ConflictError({
      code: BATCH_LABEL_PRINTER_WRONG_STOCK,
      message: `This printer is loaded with ${printer.labelStock} stock, not ${args.labelStock}.`,
      metadata: {
        printerId: printer.id,
        printerLabelStock: printer.labelStock,
        requiredLabelStock: args.labelStock,
      },
    });
  }

  const template = await args.tx.printTemplate.findFirst({
    where: {
      organizationId: args.organizationId,
      code: args.templateCode,
      labelStock: args.labelStock,
      isActive: true,
    },
    orderBy: { version: "desc" },
    select: { id: true, version: true, zplBody: true },
  });
  if (template === null) {
    throw new errors.NotFoundError({
      code: BATCH_LABEL_TEMPLATE_NOT_FOUND,
      message: "No active print template found for this label stock.",
      metadata: { templateCode: args.templateCode, labelStock: args.labelStock },
    });
  }

  return {
    printerId: printer.id,
    printerVendor: printer.vendor,
    printerProtocol: printer.protocol,
    templateId: template.id,
    templateVersion: template.version,
    zplBody: template.zplBody,
  };
}

/**
 * "No silent label reprints": a second physical label for a target
 * requires a stated reason. CANCELLED jobs are excluded — a job that
 * never reached a printer produced no label to duplicate.
 */
function assertReprintReason(args: {
  readonly priorPrintCount: number;
  readonly reprintReasonCode: string | undefined;
  readonly what: string;
}): boolean {
  const isReprint = args.priorPrintCount > 0;
  if (!isReprint) return false;
  if (args.reprintReasonCode === undefined || !isVialLabelReprintReason(args.reprintReasonCode)) {
    throw new errors.ValidationError({
      code: BATCH_LABEL_REPRINT_REASON_REQUIRED,
      message:
        `${args.what} has already been printed ${args.priorPrintCount} time(s); ` +
        `reprinting requires a reason code so a duplicate label on a shelf is explainable.`,
      issues: [{ path: ["reprintReasonCode"], message: "required when reprinting" }],
      metadata: { priorPrintCount: args.priorPrintCount },
    });
  }
  return true;
}

// ---------------------------------------------------------------------
// PrintCompoundBatchLabel
// ---------------------------------------------------------------------

const batchLabelInputSchema = z
  .object({
    batchId: z.uuid(),
    printerId: z.uuid(),
    templateCode: z.string().min(1).max(64).default(DEFAULT_COMPOUND_BATCH_TEMPLATE_CODE),
    /** Required once this batch's label has been printed before. */
    reprintReasonCode: z.enum(VIAL_LABEL_REPRINT_REASONS).optional(),
  })
  .strict();

export type PrintCompoundBatchLabelInput = z.infer<typeof batchLabelInputSchema>;

export interface PrintCompoundBatchLabelOutput {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly printJobId: string;
  readonly contentHashHex: string;
  readonly isReprint: boolean;
}

export const PrintCompoundBatchLabel = defineCommand<
  PrintCompoundBatchLabelInput,
  PrintCompoundBatchLabelOutput
>({
  name: "PrintCompoundBatchLabel",
  inputSchema: batchLabelInputSchema,
  permission: PERMISSIONS.INVENTORY_BATCH_LABEL_PRINT,
  requiresWorkstation: true,
  redactFields: [],

  async exec({ tx, ctx, input, clock, commandLogId }) {
    const batch = await loadBatchForLabeling(tx, ctx.organizationId, input.batchId);

    const priorPrintCount = await tx.printJob.count({
      where: {
        organizationId: ctx.organizationId,
        compoundBatchId: batch.batchId,
        targetKind: PrintJobTargetKind.COMPOUND_BATCH,
        status: { not: PrintJobStatus.CANCELLED },
      },
    });
    const isReprint = assertReprintReason({
      priorPrintCount,
      reprintReasonCode: input.reprintReasonCode,
      what: "This batch label",
    });

    const resolved = await resolvePrinterAndTemplate({
      tx,
      organizationId: ctx.organizationId,
      printerId: input.printerId,
      batchSiteId: batch.siteId,
      labelStock: LabelStockKind.BATCH_2X1,
      templateCode: input.templateCode,
    });

    const renderedZpl = renderCompoundBatchLabelZpl(resolved.zplBody, {
      productName: batch.productName,
      productStrength: batch.productStrength,
      pharmaxProductId: batch.pharmaxProductId as string,
      batchNumber: batch.batchNumber,
      compoundedOn: isoDay(batch.compoundedOn),
      beyondUseDate: isoDay(batch.beyondUseDate),
      unitCount: batch.unitCount,
      batchBarcodeValue: batch.barcodeValue,
    });
    const contentHash = hashZplContent(renderedZpl);

    const printJob = await tx.printJob.create({
      data: {
        organizationId: ctx.organizationId,
        targetKind: PrintJobTargetKind.COMPOUND_BATCH,
        compoundBatchId: batch.batchId,
        printerId: resolved.printerId,
        workstationId: ctx.workstationId ?? null,
        printTemplateId: resolved.templateId,
        printTemplateVersion: resolved.templateVersion,
        status: PrintJobStatus.PENDING,
        renderedZpl,
        contentHash: new Uint8Array(contentHash),
        isReprint,
        reprintReasonCode: isReprint ? (input.reprintReasonCode ?? null) : null,
        traceparent: currentTraceparent(),
        requestedByUserId: ctx.actor.userId,
        commandLogId,
      },
      select: { id: true },
    });

    const contentHashHex = contentHash.toString("hex");
    const now = clock.now();

    return {
      output: {
        batchId: batch.batchId,
        batchNumber: batch.batchNumber,
        printJobId: printJob.id,
        contentHashHex,
        isReprint,
      },
      audit: {
        action: isReprint
          ? "inventory.compound_batch_label.reprint_requested"
          : "inventory.compound_batch_label.print_requested",
        resourceType: "PrintJob",
        resourceId: printJob.id,
        metadata: {
          batchId: batch.batchId,
          batchNumber: batch.batchNumber,
          printJobId: printJob.id,
          printerId: resolved.printerId,
          printerVendor: resolved.printerVendor,
          printerProtocol: resolved.printerProtocol,
          templateCode: input.templateCode,
          templateVersion: resolved.templateVersion,
          contentHashHex,
          isReprint,
          reprintReasonCode: isReprint ? (input.reprintReasonCode ?? null) : null,
          priorPrintCount,
          workstationId: ctx.workstationId ?? null,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "labels.compound_label.requested.v1",
          aggregateType: "PrintJob",
          aggregateId: printJob.id,
          payload: {
            organizationId: ctx.organizationId,
            printJobId: printJob.id,
            targetKind: PrintJobTargetKind.COMPOUND_BATCH,
            compoundBatchId: batch.batchId,
            batchNumber: batch.batchNumber,
            printerId: resolved.printerId,
            workstationId: ctx.workstationId ?? null,
            templateCode: input.templateCode,
            templateVersion: resolved.templateVersion,
            contentHashHex,
            isReprint,
            requestedByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------
// PrintCompoundUnitLabels
// ---------------------------------------------------------------------

const unitLabelInputSchema = z
  .object({
    batchId: z.uuid(),
    printerId: z.uuid(),
    /** 1-based inclusive range. Supply both, or omit both to print the
     *  whole batch — one bound alone is rejected. */
    fromUnitNumber: z.int().positive().optional(),
    toUnitNumber: z.int().positive().optional(),
    templateCode: z.string().min(1).max(64).default(DEFAULT_COMPOUND_UNIT_TEMPLATE_CODE),
    /** Required when any unit in the range has been printed before. */
    reprintReasonCode: z.enum(VIAL_LABEL_REPRINT_REASONS).optional(),
  })
  .strict();

export type PrintCompoundUnitLabelsInput = z.infer<typeof unitLabelInputSchema>;

export interface PrintCompoundUnitLabelsOutput {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly printJobIds: ReadonlyArray<string>;
  readonly fromUnitNumber: number;
  readonly toUnitNumber: number;
  readonly isReprint: boolean;
}

export const PrintCompoundUnitLabels = defineCommand<
  PrintCompoundUnitLabelsInput,
  PrintCompoundUnitLabelsOutput
>({
  name: "PrintCompoundUnitLabels",
  inputSchema: unitLabelInputSchema,
  permission: PERMISSIONS.INVENTORY_BATCH_LABEL_PRINT,
  requiresWorkstation: true,
  redactFields: [],

  async exec({ tx, ctx, input, clock, commandLogId }) {
    const batch = await loadBatchForLabeling(tx, ctx.organizationId, input.batchId);

    // Both bounds or neither. Defaulting each side independently
    // reads as convenience but is a label-waster: a lone "5" in From
    // means "unit 5 through the end of the batch", so one distracted
    // entry on a 200-vial batch prints 196 labels the operator did not
    // ask for. "Print the whole batch" stays available — it is what
    // both fields blank means.
    if ((input.fromUnitNumber === undefined) !== (input.toUnitNumber === undefined)) {
      const missing = input.fromUnitNumber === undefined ? "fromUnitNumber" : "toUnitNumber";
      throw new errors.ValidationError({
        code: BATCH_LABEL_UNIT_RANGE_INVALID,
        message:
          "Give both a From and a To unit number, or leave both blank to print the whole batch.",
        issues: [{ path: [missing], message: "required when the other bound is given" }],
        metadata: {
          batchId: batch.batchId,
          unitCount: batch.unitCount,
          fromUnitNumber: input.fromUnitNumber ?? null,
          toUnitNumber: input.toUnitNumber ?? null,
        },
      });
    }

    const from = input.fromUnitNumber ?? 1;
    const to = input.toUnitNumber ?? batch.unitCount;
    if (to < from || from > batch.unitCount || to > batch.unitCount) {
      throw new errors.ValidationError({
        code: BATCH_LABEL_UNIT_RANGE_INVALID,
        message: `This batch has units 1–${batch.unitCount}; the requested range ${from}–${to} does not fit inside it.`,
        metadata: { batchId: batch.batchId, unitCount: batch.unitCount, from, to },
      });
    }
    const rangeSize = to - from + 1;
    if (rangeSize > COMPOUND_UNIT_LABEL_MAX_PER_COMMAND) {
      throw new errors.ValidationError({
        code: BATCH_LABEL_UNIT_RANGE_TOO_LARGE,
        message:
          `A single print run covers at most ${COMPOUND_UNIT_LABEL_MAX_PER_COMMAND} units; ` +
          `${rangeSize} were requested. Print in smaller runs.`,
        metadata: { requested: rangeSize, max: COMPOUND_UNIT_LABEL_MAX_PER_COMMAND },
      });
    }

    const units = await tx.compoundBatchUnit.findMany({
      where: {
        organizationId: ctx.organizationId,
        batchId: batch.batchId,
        unitNumber: { gte: from, lte: to },
      },
      orderBy: { unitNumber: "asc" },
      select: { id: true, unitNumber: true, serialNumber: true },
    });
    if (units.length !== rangeSize) {
      throw new errors.ValidationError({
        code: BATCH_LABEL_UNIT_RANGE_INVALID,
        message: "Some units in the requested range do not exist for this batch.",
        metadata: { requested: rangeSize, found: units.length },
      });
    }

    const priorPrintCount = await tx.printJob.count({
      where: {
        organizationId: ctx.organizationId,
        compoundBatchUnitId: { in: units.map((u) => u.id) },
        status: { not: PrintJobStatus.CANCELLED },
      },
    });
    const isReprint = assertReprintReason({
      priorPrintCount,
      reprintReasonCode: input.reprintReasonCode,
      what: `One or more units in ${from}–${to}`,
    });

    const resolved = await resolvePrinterAndTemplate({
      tx,
      organizationId: ctx.organizationId,
      printerId: input.printerId,
      batchSiteId: batch.siteId,
      labelStock: LabelStockKind.VIAL,
      templateCode: input.templateCode,
    });

    const beyondUseDate = isoDay(batch.beyondUseDate);
    const traceparent = currentTraceparent();
    const now = clock.now();

    // One job per unit rather than one concatenated stream. The extra
    // rows buy per-unit attribution: a jam on unit 23 is recorded
    // against unit 23, and "prove vial 23's label printed" is a single
    // row lookup instead of an inference about a bulk job.
    const printJobIds: string[] = [];
    const emits: Array<{
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    }> = [];

    for (const unit of units) {
      const renderedZpl = renderCompoundUnitLabelZpl(resolved.zplBody, {
        productName: batch.productName,
        productStrength: batch.productStrength,
        beyondUseDate,
        unitNumber: unit.unitNumber,
        unitCount: batch.unitCount,
        serialNumber: unit.serialNumber,
      });
      const contentHash = hashZplContent(renderedZpl);

      const printJob = await tx.printJob.create({
        data: {
          organizationId: ctx.organizationId,
          targetKind: PrintJobTargetKind.COMPOUND_UNIT,
          compoundBatchId: batch.batchId,
          compoundBatchUnitId: unit.id,
          printerId: resolved.printerId,
          workstationId: ctx.workstationId ?? null,
          printTemplateId: resolved.templateId,
          printTemplateVersion: resolved.templateVersion,
          status: PrintJobStatus.PENDING,
          renderedZpl,
          contentHash: new Uint8Array(contentHash),
          isReprint,
          reprintReasonCode: isReprint ? (input.reprintReasonCode ?? null) : null,
          traceparent,
          requestedByUserId: ctx.actor.userId,
          commandLogId,
        },
        select: { id: true },
      });
      printJobIds.push(printJob.id);

      emits.push({
        eventType: "labels.compound_label.requested.v1",
        aggregateType: "PrintJob",
        aggregateId: printJob.id,
        payload: {
          organizationId: ctx.organizationId,
          printJobId: printJob.id,
          targetKind: PrintJobTargetKind.COMPOUND_UNIT,
          compoundBatchId: batch.batchId,
          compoundBatchUnitId: unit.id,
          batchNumber: batch.batchNumber,
          serialNumber: unit.serialNumber,
          printerId: resolved.printerId,
          workstationId: ctx.workstationId ?? null,
          templateCode: input.templateCode,
          templateVersion: resolved.templateVersion,
          contentHashHex: contentHash.toString("hex"),
          isReprint,
          requestedByUserId: ctx.actor.userId,
          occurredAt: now.toISOString(),
        },
      });
    }

    return {
      output: {
        batchId: batch.batchId,
        batchNumber: batch.batchNumber,
        printJobIds,
        fromUnitNumber: from,
        toUnitNumber: to,
        isReprint,
      },
      audit: {
        action: isReprint
          ? "inventory.compound_unit_label.reprint_requested"
          : "inventory.compound_unit_label.print_requested",
        resourceType: "CompoundBatch",
        resourceId: batch.batchId,
        metadata: {
          batchId: batch.batchId,
          batchNumber: batch.batchNumber,
          fromUnitNumber: from,
          toUnitNumber: to,
          unitsPrinted: units.length,
          printJobIds,
          printerId: resolved.printerId,
          templateCode: input.templateCode,
          templateVersion: resolved.templateVersion,
          isReprint,
          reprintReasonCode: isReprint ? (input.reprintReasonCode ?? null) : null,
          priorPrintCount,
          workstationId: ctx.workstationId ?? null,
          commandLogId,
        },
      },
      emits,
    };
  },
});
