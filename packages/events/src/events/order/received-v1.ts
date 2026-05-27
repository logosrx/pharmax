// order.received.v1 — a new order was created.
//
// Producer: `CreateOrder` command (`@pharmax/orders`).
// Consumers: SLA timer (WAIT_BEFORE_TYPING interval starts), queue
//   counter dashboards. None subscribe to PHI.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    siteId: z.uuid(),
    bucketId: z.uuid(),
    workflowPolicyId: z.uuid(),
    workflowPolicyVersion: z.number().int().min(1),
    receivedAt: z.iso.datetime({ offset: true }),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderReceivedV1 = defineEvent({
  name: "order.received",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "orders",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by CreateOrder after the order row, its initial bucket placement, and workflow policy stamps are persisted. Starts the WAIT_BEFORE_TYPING SLA interval.",
});

export type OrderReceivedV1Payload = z.infer<typeof payloadSchema>;
