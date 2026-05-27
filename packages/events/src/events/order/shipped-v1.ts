// order.shipped.v1 — physical shipment was confirmed.
//
// Producer: `ConfirmShipment` (`@pharmax/shipping`).
// Consumers:
//   - `MaterializeShippedOrderBilling` (`@pharmax/billing`) — turns
//     the shipped event into an invoice line.
//   - SLA timer (closes SHIPPING_ACTIVE).
//   - Future patient-notification handler.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    /**
     * Clinic surfaced so the billing materialization handler can
     * attribute the invoice line to the right clinic without a
     * second cross-tenant lookup (see
     * `apps/worker/src/drains/materialize-billing-on-order-shipped.ts`).
     */
    clinicId: z.uuid(),
    siteId: z.uuid(),
    shipmentId: z.uuid(),
    /**
     * Tracking number is optional because some shipments (label-
     * purchase-deferred carriers, in-house couriers) confirm before
     * the carrier returns a tracking id. The billing materializer
     * does not require it; downstream patient notifications gate on
     * its presence.
     */
    trackingNumber: z.string().min(1).max(64).nullable(),
    shippingClerkUserId: z.uuid(),
    bucketId: z.uuid(),
    transitionId: z.string().min(1),
    fromState: z.string().min(1),
    toState: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderShippedV1 = defineEvent({
  name: "order.shipped",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by ConfirmShipment when the physical shipment is handed off. Drives invoice-line materialization and closes the shipping SLA interval.",
});

export type OrderShippedV1Payload = z.infer<typeof payloadSchema>;
