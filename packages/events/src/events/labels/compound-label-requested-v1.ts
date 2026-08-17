// labels.compound_label.requested.v1 — a compound stock label was
// queued for printing.
//
// Covers both compound label kinds via `targetKind`:
//
//   COMPOUND_BATCH — the batch record label (barcode + Pharmax Product
//     ID + batch number).
//   COMPOUND_UNIT  — one per-unit vial label, carrying that unit's
//     serial. A print run of 40 vials emits 40 of these, one per unit,
//     which is what makes "prove unit 23's label printed" a single row
//     lookup rather than an inference about a bulk job.
//
// Deliberately NOT a widened `labels.vial_print.requested.v1`: that
// event declares `orderId` and `orderLineId` as required UUIDs, and a
// compound batch has neither. Relaxing them to nullable would weaken a
// contract the patient-vial path depends on, and an event carrying
// `orderId: null` is a worse description of a batch label than one
// carrying `compoundBatchId`.
//
// Consumers: the worker drain that moves the job PENDING → SENT for the
// print agent to claim.
//
// PHI-safe: a compound batch has no patient by construction.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    printJobId: z.uuid(),
    targetKind: z.enum(["COMPOUND_BATCH", "COMPOUND_UNIT"]),
    compoundBatchId: z.uuid(),
    /** Present only for COMPOUND_UNIT. */
    compoundBatchUnitId: z.uuid().optional(),
    batchNumber: z.string(),
    /** Present only for COMPOUND_UNIT: the unit's printed serial. */
    serialNumber: z.string().optional(),
    printerId: z.uuid(),
    workstationId: z.uuid().nullable(),
    templateCode: z.string(),
    templateVersion: z.number().int().positive(),
    /** SHA-256 of the rendered ZPL, so content is verifiable without
     *  putting rendered label bytes in an event. */
    contentHashHex: z.string(),
    isReprint: z.boolean(),
    requestedByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const LabelsCompoundLabelRequestedV1 = defineEvent({
  name: "labels.compound_label.requested",
  version: 1,
  aggregateType: "PrintJob",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.printJobId,
  owner: "labels",
  retention: "7y",
  phiSafe: true,
  routingKey: "labels.compound_label",
  description:
    "Emitted by PrintCompoundBatchLabel and PrintCompoundUnitLabels when a compound stock label is queued. Drives the worker drain that hands the job to the print agent. Carries the rendered-ZPL content hash but never the ZPL itself.",
});

export type LabelsCompoundLabelRequestedV1Payload = z.infer<typeof payloadSchema>;
