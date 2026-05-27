// order.shipment.label_purchased.v1 — a postage label was purchased from a carrier.
//
// Producer: `PurchaseShipmentLabel` (`@pharmax/shipping`).
// Consumers: label-print bridge; postage-cost reporting; future
//   carrier-credential-usage audit.
//
// PHI: none. `fromAddress` and `toAddress` (the address objects)
// are command inputs but are redacted from `command_log` and
// NEVER included in this payload — only the resulting carrier
// ids + cost are surfaced.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const SHIPMENT_CARRIERS = ["USPS", "UPS", "FEDEX", "DHL", "OTHER"] as const;
const SHIPPING_PROVIDERS = ["EASYPOST", "MANUAL"] as const;

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    shipmentId: z.uuid(),
    /** Pharmax-internal shipping provider code. */
    provider: z.enum(SHIPPING_PROVIDERS),
    /** Vendor-friendly display name (e.g. "EasyPost"). */
    providerName: z.string().min(1).max(64),
    /**
     * Carrier credential used to purchase the label. Null when
     * the provider is `MANUAL` (no credential involved).
     */
    credentialId: z.uuid().nullable(),
    carrier: z.enum(SHIPMENT_CARRIERS),
    serviceLevel: z.string().min(1).max(64),
    trackingNumber: z.string().min(1).max(64),
    /** Carrier-side shipment id (e.g. EasyPost `shp_...`). */
    externalShipmentId: z.string().min(1).max(128),
    /** Carrier-side tracker id (e.g. EasyPost `trk_...`). */
    externalTrackerId: z.string().min(1).max(128),
    /** Postage cost in integer cents. */
    postageRateCents: z.number().int().min(0),
    createdByUserId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderShipmentLabelPurchasedV1 = defineEvent({
  name: "order.shipment.label_purchased",
  version: 1,
  aggregateType: "Shipment",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.shipmentId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "shipment.lifecycle",
  description:
    "Emitted by PurchaseShipmentLabel after the carrier returns a postage label. Surfaces the carrier ids + postage cost; addresses are redacted upstream and never included.",
});

export type OrderShipmentLabelPurchasedV1Payload = z.infer<typeof payloadSchema>;
