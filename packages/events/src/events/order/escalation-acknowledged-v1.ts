// order.escalation_acknowledged.v1 — operator claimed the emergency, kept it in EMERGENCY.
//
// Producer: `ResolveOrderEscalation` (`@pharmax/shipping`),
//   KEEP_IN_EMERGENCY branch — the operator acknowledged the
//   exception but is keeping the order parked in the emergency
//   bucket pending further investigation.
// Consumers: SHIPMENT_ESCALATION_ACKNOWLEDGED_V1 notification.
//
// PHI: none. Free-text reason note lives on the encrypted
// `order_escalation_resolution.reasonText` column.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const ESCALATION_DISPOSITIONS = [
  "RETURN_TO_SHIPPING",
  "RETURN_TO_FILL",
  "KEEP_IN_EMERGENCY",
] as const;

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    /**
     * Always `KEEP_IN_EMERGENCY` for this event variant. Carried
     * in the payload so a single union projector can read
     * disposition off both `acknowledged` and `resolved` events.
     */
    disposition: z.enum(ESCALATION_DISPOSITIONS),
    hasReasonText: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderEscalationAcknowledgedV1 = defineEvent({
  name: "order.escalation_acknowledged",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.exception",
  description:
    "Emitted by ResolveOrderEscalation's KEEP_IN_EMERGENCY branch — operator acknowledged the exception but kept the order parked in the emergency bucket.",
});

export type OrderEscalationAcknowledgedV1Payload = z.infer<typeof payloadSchema>;
