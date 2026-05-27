// order.shipment_escalation_reaffirmed.v1 — repeat escalation arrived; no bucket move.
//
// Producer: `EscalateOrderToEmergencyBucket` (`@pharmax/shipping`),
//   "already escalated" branch — when an order is already parked
//   in the EMERGENCY bucket and a new delivery-failure tracking
//   event arrives, the command writes an audit row + this event
//   instead of double-moving the order.
// Consumers: ops-lead "still failing" alert; recurring-failure
//   detector (multiple reaffirmations within a window).
//
// PHI: none. Carrier ids + status only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const ESCALATION_REASONS = ["EXCEPTION", "FAILED_DELIVERY", "RETURN_TO_SENDER"] as const;

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    shipmentId: z.uuid(),
    trackingEventId: z.uuid(),
    externalEventId: z.string().min(1).max(128),
    reason: z.enum(ESCALATION_REASONS),
    carrierStatus: z.string().min(1).max(64),
    /** When the carrier reported the (latest) failure. */
    occurredAt: z.iso.datetime({ offset: true }),
    /** When Pharmax recorded the reaffirmation. */
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderShipmentEscalationReaffirmedV1 = defineEvent({
  name: "order.shipment_escalation_reaffirmed",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.exception",
  description:
    "Emitted by EscalateOrderToEmergencyBucket when a new delivery-failure event arrives for an order already in EMERGENCY. Captures the repeat signal without re-moving the bucket.",
});

export type OrderShipmentEscalationReaffirmedV1Payload = z.infer<typeof payloadSchema>;
