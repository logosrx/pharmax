// order.fill.started.v1 — fill tech claimed the order from the FILL queue.
//
// Producer: `StartFill` (`@pharmax/fill`).
// Consumers: SLA timer (closes WAIT_BEFORE_FILL / opens
//   FILL_ACTIVE); queue-counter dashboard.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    fillTechUserId: z.uuid(),
    bucketId: z.uuid(),
    transitionId: z.string().min(1),
    fromState: z.string().min(1),
    toState: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderFillStartedV1 = defineEvent({
  name: "order.fill.started",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "fill",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by StartFill when a fill technician claims the order. Closes WAIT_BEFORE_FILL / opens FILL_ACTIVE on the SLA timeline.",
});

export type OrderFillStartedV1Payload = z.infer<typeof payloadSchema>;
