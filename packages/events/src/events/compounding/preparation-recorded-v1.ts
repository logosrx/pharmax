// compounding.preparation.recorded.v1 — a compounding preparation was
// documented at the fill stage: the USP <795>/<797> Compounding Record
// row exists, ingredient lots were consumed into the inventory ledger,
// and the BUD was computed.
//
// Producer: `RecordCompoundingPreparation` (`@pharmax/compounding`).
// Consumers: lot-traceability audit feed (which ingredient lots went
//   into which preparation — recall response); formulary usage
//   projections; slice-3 DSCSA layering.
//
// PHI-safe: ids + recipe identity + QC outcome only. The rendered
// record document (which carries order/rx identifiers) stays on the
// row behind RLS and is never emitted.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    compoundingRecordId: z.uuid(),
    organizationId: z.uuid(),
    orderId: z.uuid(),
    orderLineId: z.uuid(),
    formulaId: z.uuid(),
    formulaCode: z.string(),
    formulaVersion: z.number().int().positive(),
    preparedByUserId: z.uuid(),
    /** Computed beyond-use date (preparedAt + budDays, clamped to the
     *  earliest consumed-ingredient expiration). */
    budAt: z.iso.datetime({ offset: true }),
    qualityOutcome: z.enum(["PASS", "FAIL"]),
    /** USP <800>: the formula involved a hazardous drug. */
    hazardous: z.boolean(),
    /** Lot ids consumed by this preparation (product-backed
     *  ingredients only) — the recall-response anchor. */
    consumedLotIds: z.array(z.uuid()),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const CompoundingPreparationRecordedV1 = defineEvent({
  name: "compounding.preparation.recorded",
  version: 1,
  aggregateType: "CompoundingRecord",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.compoundingRecordId,
  owner: "compounding",
  retention: "7y",
  phiSafe: true,
  routingKey: "compounding.preparation",
  description:
    "Emitted by RecordCompoundingPreparation when a USP compounding record is written at the fill stage (ADR-0035 slice 2). Carries consumed lot ids for recall traceability; the rendered record document never leaves the row.",
});

export type CompoundingPreparationRecordedV1Payload = z.infer<typeof payloadSchema>;
