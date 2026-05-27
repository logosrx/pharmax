// fill.lot.assigned.v1 — a specific inventory lot was bound to an order line.
//
// Producer: `AssignLot` (`@pharmax/fill`).
// Consumers: inventory delta projection; lot-traceability audit
//   feed (which lot went into which order — recall preparation).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    orderId: z.uuid(),
    orderLineId: z.uuid(),
    lotId: z.uuid(),
    /**
     * Id of the `lot_assignment` row created by this command.
     * One assignment row per attach (a reassignment writes a new
     * row + supersedes the prior one); consumers correlate
     * here to dedupe vs. the lot itself.
     */
    lotAssignmentId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const FillLotAssignedV1 = defineEvent({
  name: "fill.lot.assigned",
  version: 1,
  aggregateType: "OrderLine",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderLineId,
  owner: "fill",
  retention: "7y",
  phiSafe: true,
  routingKey: "fill.inventory",
  description:
    "Emitted by AssignLot after an inventory lot is bound to an order line. Anchors the lot-traceability audit feed used for recall response.",
});

export type FillLotAssignedV1Payload = z.infer<typeof payloadSchema>;
