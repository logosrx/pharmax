// CreateCompoundBatch — record a finished production run of an
// in-house compound and mint every unit's serial number.
//
// The compounding team runs this the moment the batch physically
// exists. One transaction writes:
//
//   1. The `compound_batch` row — batch number
//      ("MAIN-T30-1-081626"), Beyond-Use Date, unit count, barcode
//      value, status COMPOUNDED.
//   2. One `compound_batch_unit` row PER UNIT, each with its final
//      serial ("MAIN-T30-1-081626-11"). Serials are born with the
//      batch, not printed later on demand — a vial that exists
//      without a serial is untraceable by definition.
//
// The batch-of-the-day counter (`daySequence`) is allocated as
// COUNT+1 over this (site, product, compoundedOn). That read races
// with a concurrent creation, so the unique constraint on
// (org, site, product, compoundedOn, daySequence) is the arbiter:
// the loser's P2002 surfaces as a typed retryable conflict instead
// of two batches sharing a serial prefix.
//
// The serial identity (drug initial + mg) comes from the PRODUCT —
// frozen at CreateCompoundProduct time — never from input. An
// operator who could type "T30" per batch could also typo "T3O".
//
// Non-order aggregate: plain `Command` shape, like ReceiveLot.
// Catalog/inventory data only — no PHI anywhere in this command.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { Prisma, ProductNdcKind } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  buildBatchBarcodeValue,
  buildBatchNumber,
  buildUnitSerial,
  normalizeSiteSerialCode,
} from "../compound-batch-serial.js";
import {
  BATCH_BUD_NOT_AFTER_COMPOUNDING,
  BATCH_CREATE_CONFLICT,
  BATCH_PRODUCT_NOT_COMPOUND,
  BATCH_PRODUCT_SERIAL_IDENTITY_MISSING,
  BATCH_SITE_CODE_UNUSABLE,
  INVENTORY_PRODUCT_NOT_FOUND,
  INVENTORY_SITE_NOT_FOUND,
} from "../shared.js";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const inputSchema = z
  .object({
    siteId: z.uuid(),
    productId: z.uuid(),
    /** Units produced by this run (vials/tablets/… per the product's
     *  unitKind). Each gets its own serial row, so the cap bounds the
     *  transaction's write volume. */
    unitCount: z.int().positive().max(5000),
    /** Calendar date the batch was compounded (the date printed in
     *  every serial). Usually today; past dates are allowed because
     *  recording can lag the bench work. */
    compoundedOn: z.iso.date(),
    /** Beyond-Use Date (USP <797>). Must be after compoundedOn. */
    beyondUseDate: z.iso.date(),
  })
  .strict();

export type CreateCompoundBatchInput = z.infer<typeof inputSchema>;

export interface CreateCompoundBatchOutput {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly barcodeValue: string;
  readonly daySequence: number;
  readonly unitCount: number;
  readonly firstSerial: string;
  readonly lastSerial: string;
}

function utcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const CreateCompoundBatch: Command<CreateCompoundBatchInput, CreateCompoundBatchOutput> = {
  name: "CreateCompoundBatch",
  inputSchema,
  permission: PERMISSIONS.INVENTORY_BATCH_CREATE,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<CreateCompoundBatchOutput>> {
    const now = clock.now();

    const compoundedOn = utcDate(input.compoundedOn);
    const beyondUseDate = utcDate(input.beyondUseDate);
    if (beyondUseDate <= compoundedOn) {
      throw new errors.ValidationError({
        code: BATCH_BUD_NOT_AFTER_COMPOUNDING,
        message: "The Beyond-Use Date must be after the compounding date.",
        metadata: { compoundedOn: input.compoundedOn, beyondUseDate: input.beyondUseDate },
      });
    }

    const site = await tx.pharmacySite.findFirst({
      where: { id: input.siteId, organizationId: ctx.organizationId },
      select: { id: true, code: true },
    });
    if (site === null) {
      throw new errors.NotFoundError({
        code: INVENTORY_SITE_NOT_FOUND,
        message: "Pharmacy site not found in this organization.",
        metadata: { siteId: input.siteId },
      });
    }

    const siteCode = normalizeSiteSerialCode(site.code);
    if (siteCode === null) {
      throw new errors.ValidationError({
        code: BATCH_SITE_CODE_UNUSABLE,
        message:
          "This site's code contains no letters or digits and cannot be printed in a serial number; fix the site code first.",
        metadata: { siteId: input.siteId },
      });
    }

    const product = await tx.product.findFirst({
      where: { id: input.productId, organizationId: ctx.organizationId },
      select: {
        id: true,
        name: true,
        strength: true,
        ndcKind: true,
        pharmaxProductId: true,
        serialDrugInitial: true,
        serialDrugMg: true,
        unitKind: true,
      },
    });
    if (product === null) {
      throw new errors.NotFoundError({
        code: INVENTORY_PRODUCT_NOT_FOUND,
        message: "Product not found in this organization's catalog.",
        metadata: { productId: input.productId },
      });
    }
    if (product.ndcKind !== ProductNdcKind.IN_HOUSE_COMPOUND || product.pharmaxProductId === null) {
      throw new errors.ValidationError({
        code: BATCH_PRODUCT_NOT_COMPOUND,
        message:
          "Batches can only be created for in-house compound products; manufactured stock arrives through DSCSA receiving.",
        metadata: { productId: input.productId },
      });
    }
    if (product.serialDrugInitial === null || product.serialDrugMg === null) {
      throw new errors.ValidationError({
        code: BATCH_PRODUCT_SERIAL_IDENTITY_MISSING,
        message:
          "This compound has no serial identity (drug initial + mg) on file, so unit serials cannot be minted.",
        metadata: { productId: input.productId },
      });
    }

    // Batch-of-the-day counter: COUNT+1 races with a concurrent
    // creation; the unique constraint below settles it (P2002 → typed
    // retryable conflict).
    const priorToday = await tx.compoundBatch.count({
      where: {
        organizationId: ctx.organizationId,
        siteId: input.siteId,
        productId: input.productId,
        compoundedOn,
      },
    });
    const daySequence = priorToday + 1;

    const batchNumber = buildBatchNumber({
      siteCode,
      serialDrugInitial: product.serialDrugInitial,
      serialDrugMg: product.serialDrugMg,
      daySequence,
      compoundedOn: input.compoundedOn,
    });
    const barcodeValue = buildBatchBarcodeValue(product.pharmaxProductId, batchNumber);

    const batchId = randomUUID();
    try {
      await tx.compoundBatch.create({
        data: {
          id: batchId,
          organizationId: ctx.organizationId,
          siteId: input.siteId,
          productId: input.productId,
          batchNumber,
          daySequence,
          compoundedOn,
          beyondUseDate,
          unitCount: input.unitCount,
          barcodeValue,
          createdByUserId: ctx.actor.userId,
          commandLogId,
        },
      });
      await tx.compoundBatchUnit.createMany({
        data: Array.from({ length: input.unitCount }, (_, i) => ({
          organizationId: ctx.organizationId,
          batchId,
          unitNumber: i + 1,
          serialNumber: buildUnitSerial(batchNumber, i + 1),
        })),
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new errors.ConflictError({
          code: BATCH_CREATE_CONFLICT,
          cause: err,
          message:
            "A concurrent batch creation took this batch-of-the-day number; retry to get the next one.",
          metadata: { batchNumber },
        });
      }
      throw err;
    }

    return {
      output: {
        batchId,
        batchNumber,
        barcodeValue,
        daySequence,
        unitCount: input.unitCount,
        firstSerial: buildUnitSerial(batchNumber, 1),
        lastSerial: buildUnitSerial(batchNumber, input.unitCount),
      },
      audit: {
        action: "inventory.compound_batch.created",
        resourceType: "CompoundBatch",
        resourceId: batchId,
        metadata: {
          siteId: input.siteId,
          productId: input.productId,
          pharmaxProductId: product.pharmaxProductId,
          batchNumber,
          daySequence,
          compoundedOn: input.compoundedOn,
          beyondUseDate: input.beyondUseDate,
          unitCount: input.unitCount,
          barcodeValue,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "inventory.compound_batch.created.v1",
          aggregateType: "CompoundBatch",
          aggregateId: batchId,
          payload: {
            organizationId: ctx.organizationId,
            batchId,
            siteId: input.siteId,
            productId: input.productId,
            pharmaxProductId: product.pharmaxProductId,
            batchNumber,
            daySequence,
            compoundedOn: input.compoundedOn,
            beyondUseDate: input.beyondUseDate,
            unitCount: input.unitCount,
            barcodeValue,
            createdByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
