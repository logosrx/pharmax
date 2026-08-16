// inventory.compound_batch.status_changed.v1 — a compound batch moved
// through its quality lifecycle:
//
//   COMPOUNDED → TESTING      (sent to the independent lab)
//   TESTING    → RELEASED     (lab passed it; eligible to dispense)
//   TESTING    → REJECTED     (lab failed it; reasonCode present)
//   RELEASED   → DISPENSING   (now the batch orders fill from;
//                              demotedBatchId names the incumbent
//                              that went back to RELEASED, if any)
//
// One event for all four edges, carrying the from/to pair, so
// consumers see a single uniform stream instead of four event types
// with identical shapes.
//
// Producers: SendCompoundBatchToTesting / ReleaseCompoundBatch /
//   RejectCompoundBatch / StartDispensingCompoundBatch
//   (`@pharmax/inventory`).
// Consumers: inventory dashboards, "stuck at the lab" SLA timers,
//   label/traceability projections.
//
// PHI-safe: batch/catalog identity and status only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const statusSchema = z.enum(["COMPOUNDED", "TESTING", "RELEASED", "DISPENSING", "REJECTED"]);

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    batchId: z.uuid(),
    siteId: z.uuid(),
    productId: z.uuid(),
    batchNumber: z.string(),
    fromStatus: statusSchema,
    toStatus: statusSchema,
    /** Present exactly when toStatus = REJECTED — "every rejection
     *  requires a reason code". */
    reasonCode: z.string().optional(),
    /** On RELEASED → DISPENSING: the incumbent dispensing batch that
     *  was demoted back to RELEASED, when one existed. */
    demotedBatchId: z.uuid().optional(),
    changedByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const InventoryCompoundBatchStatusChangedV1 = defineEvent({
  name: "inventory.compound_batch.status_changed",
  version: 1,
  aggregateType: "CompoundBatch",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.batchId,
  owner: "inventory",
  retention: "7y",
  phiSafe: true,
  routingKey: "inventory.compound_batch",
  description:
    "Emitted by the compound-batch lifecycle commands on every quality-status edge (COMPOUNDED → TESTING → RELEASED ⇄ DISPENSING, TESTING → REJECTED with reasonCode). Carries the from/to pair so all edges form one uniform stream.",
});

export type InventoryCompoundBatchStatusChangedV1Payload = z.infer<typeof payloadSchema>;
