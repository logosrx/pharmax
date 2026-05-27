// order.ship.released.v1 — order released to the shipping queue.
//
// Producer: `ReleaseToShip` (`@pharmax/shipping`).
// Consumers: shipping dashboard.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    shippingClerkUserId: z.uuid(),
    bucketId: z.uuid(),
    transitionId: z.string().min(1),
    fromState: z.string().min(1),
    toState: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderShipReleasedV1 = defineEvent({
  name: "order.ship.released",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by ReleaseToShip — order is ready for label purchase and physical handoff to the carrier.",
});

export type OrderShipReleasedV1Payload = z.infer<typeof payloadSchema>;
