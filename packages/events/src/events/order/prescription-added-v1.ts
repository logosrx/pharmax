// order.prescription.added.v1 — a line item (prescription) was added.
//
// Producer: `AddPrescription` (`@pharmax/orders`).
// Consumers: order-detail projection; future "intake completeness"
//   counter (typed reviews compare expected vs added).
//
// PHI: none. The prescription DETAILS (drug name, sig, days
// supply detail) live on the encrypted `prescription` row; only
// ids + non-PHI fill quantities are in the payload.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    siteId: z.uuid(),
    prescriptionId: z.uuid(),
    orderLineId: z.uuid(),
    /** Integer quantity to dispense for this line. */
    quantityToFill: z.number().int().min(1),
    /** Integer days supply. */
    daysSupplyToFill: z.number().int().min(1),
    /**
     * Order row's version BEFORE the bumpVersion CAS fires.
     * Captured for replay diagnostics; consumers should NOT rely
     * on it for serialization order — that's the order_event
     * sequence number's job.
     */
    fromVersion: z.number().int().min(0),
    toVersion: z.number().int().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderPrescriptionAddedV1 = defineEvent({
  name: "order.prescription.added",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "orders",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by AddPrescription after a new order line + prescription row are persisted. Carries ids + quantities — never decrypted prescription PHI.",
});

export type OrderPrescriptionAddedV1Payload = z.infer<typeof payloadSchema>;
