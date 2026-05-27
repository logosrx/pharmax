// shipment.tracking.recorded.v1 — a carrier tracking event was recorded.
//
// Producer: `RecordShipmentTrackingEvent` (`@pharmax/shipping`).
// Consumers:
//   - `EscalateOrderToEmergencyBucket` (`@pharmax/shipping`) — fires
//     when `kind` is EXCEPTION / FAILED_DELIVERY / RETURN_TO_SENDER.
//   - Future patient-status-page update.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const TRACKING_KINDS = [
  "PRE_TRANSIT",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "EXCEPTION",
  "FAILED_DELIVERY",
  "RETURN_TO_SENDER",
] as const;

const TRACKING_SOURCES = ["EASYPOST", "FEDEX", "UPS", "USPS", "DHL", "MANUAL"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    shipmentId: z.uuid(),
    orderId: z.uuid(),
    siteId: z.uuid(),
    source: z.enum(TRACKING_SOURCES),
    trackingEventId: z.uuid(),
    /** Carrier-supplied event id, used as part of the bus idempotency key. */
    externalEventId: z.string().min(1).max(128),
    kind: z.enum(TRACKING_KINDS),
    carrierStatus: z.string().min(1).max(64),
    occurredAt: z.iso.datetime({ offset: true }),
    cachedStatusAdvanced: z.boolean(),
  })
  .strict();

export const ShipmentTrackingRecordedV1 = defineEvent({
  name: "shipment.tracking.recorded",
  version: 1,
  aggregateType: "Shipment",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.shipmentId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "shipment.tracking",
  description:
    "Emitted by RecordShipmentTrackingEvent — every carrier-side state change. Exception kinds drive the EMERGENCY bucket escalation.",
});

export type ShipmentTrackingRecordedV1Payload = z.infer<typeof payloadSchema>;
