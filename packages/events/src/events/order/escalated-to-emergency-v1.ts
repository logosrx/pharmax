// order.escalated_to_emergency.v1 — order moved into the EMERGENCY bucket.
//
// Producer: `EscalateOrderToEmergencyBucket` (`@pharmax/shipping`).
// Consumers: SHIPMENT_ESCALATED_V1 notification template; ops-lead
//   email alert; emergency-queue counter.
//
// PHI: none — shipment + tracking ids + carrier status only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const ESCALATION_REASONS = ["EXCEPTION", "FAILED_DELIVERY", "RETURN_TO_SENDER"] as const;

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    shipmentId: z.uuid(),
    trackingEventId: z.uuid(),
    /**
     * Carrier-supplied event id that triggered the escalation.
     * Part of the bus idempotency key
     * (`escalate:{shipmentId}:{externalEventId}`).
     */
    externalEventId: z.string().min(1).max(128),
    reason: z.enum(ESCALATION_REASONS),
    /** Raw carrier status string (e.g. EasyPost's `status_detail`). */
    carrierStatus: z.string().min(1).max(64),
    /** Bucket the order was IN before the escalation. */
    previousBucketId: z.uuid(),
    /** The EMERGENCY bucket the order moves INTO. */
    newBucketId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderEscalatedToEmergencyV1 = defineEvent({
  name: "order.escalated_to_emergency",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.exception",
  description:
    "Emitted by EscalateOrderToEmergencyBucket when a delivery-failure tracking event moves the order into the EMERGENCY bucket. Drives the ops-lead alert + dashboard counter.",
});

export type OrderEscalatedToEmergencyV1Payload = z.infer<typeof payloadSchema>;
