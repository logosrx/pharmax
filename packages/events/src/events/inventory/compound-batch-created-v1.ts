// inventory.compound_batch.created.v1 — a finished production run of
// an in-house compound was recorded: the batch row exists in
// COMPOUNDED with its batch number, Beyond-Use Date, and barcode
// value, and every unit's serial number was minted with it.
//
// Producer: `CreateCompoundBatch` (`@pharmax/inventory`).
// Consumers: label rendering (batch/vial ZPL), inventory dashboards,
//   the traceability spine (this event is the birth certificate every
//   later scan of these serials resolves back to).
//
// PHI-safe: catalog/production identity only — no patient data exists
// at batch creation time by construction.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    batchId: z.uuid(),
    siteId: z.uuid(),
    productId: z.uuid(),
    pharmaxProductId: z.string(),
    /** e.g. "MAIN-T30-1-081626" — site code, serial identity,
     *  batch-of-the-day, compounding date (MMDDYY). */
    batchNumber: z.string(),
    daySequence: z.number().int().positive(),
    compoundedOn: z.iso.date(),
    beyondUseDate: z.iso.date(),
    /** Units produced; one serial row exists per unit. */
    unitCount: z.number().int().positive(),
    /** Scannable payload: "PXB:<pharmaxProductId>:<batchNumber>". */
    barcodeValue: z.string(),
    createdByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const InventoryCompoundBatchCreatedV1 = defineEvent({
  name: "inventory.compound_batch.created",
  version: 1,
  aggregateType: "CompoundBatch",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.batchId,
  owner: "inventory",
  retention: "7y",
  phiSafe: true,
  routingKey: "inventory.compound_batch",
  description:
    "Emitted by CreateCompoundBatch when a finished compound production run is recorded: batch number, BUD, barcode value, and one minted serial per unit. The batch starts in COMPOUNDED.",
});

export type InventoryCompoundBatchCreatedV1Payload = z.infer<typeof payloadSchema>;
