// order.shipment.created.v1 — a shipment row was created for an order.
//
// Producer:
//   - `CreateShipment` (`@pharmax/shipping`) — manual ops-typed
//     shipment with caller-supplied tracking number.
//   - `PurchaseShipmentLabel` (`@pharmax/shipping`) — emits the
//     same bridge event so subscribers ("queue counters", "shipment
//     created" hooks) fire for both manual and purchased shipments.
// Consumers: shipping-queue dashboard; shipment-tracking polling
//   subscription.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const SHIPMENT_CARRIERS = ["USPS", "UPS", "FEDEX", "DHL", "OTHER"] as const;

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    shipmentId: z.uuid(),
    carrier: z.enum(SHIPMENT_CARRIERS),
    /**
     * Carrier-specific service level (e.g. `priority`,
     * `ground_advantage`). Free string because the value space
     * varies across carriers; consumers that need a normalized
     * code use the carrier-specific adapter.
     */
    serviceLevel: z.string().min(1).max(64),
    /**
     * Tracking number for manual shipments; for purchased labels
     * the matching `order.shipment.label_purchased.v1` event also
     * fires, with the same tracking number.
     */
    trackingNumber: z.string().min(1).max(64),
    createdByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderShipmentCreatedV1 = defineEvent({
  name: "order.shipment.created",
  version: 1,
  aggregateType: "Shipment",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.shipmentId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "shipment.lifecycle",
  description:
    "Emitted by CreateShipment (and as a bridge event by PurchaseShipmentLabel) after a shipment row is persisted for an order. Drives shipping-queue counters and tracking polling.",
});

export type OrderShipmentCreatedV1Payload = z.infer<typeof payloadSchema>;
