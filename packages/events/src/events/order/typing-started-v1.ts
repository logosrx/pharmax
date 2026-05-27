// order.typing.started.v1 — typist claimed the order from the TYPING queue.
//
// Producer: `StartTyping` (`@pharmax/verification`).
// Consumers: SLA timer (closes WAIT_BEFORE_TYPING / opens
//   TYPING_ACTIVE); queue-counter dashboard.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    typistUserId: z.uuid(),
    bucketId: z.uuid(),
    transitionId: z.string().min(1),
    fromState: z.string().min(1),
    toState: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderTypingStartedV1 = defineEvent({
  name: "order.typing.started",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by StartTyping when a typist claims an order. Closes WAIT_BEFORE_TYPING / opens TYPING_ACTIVE on the SLA timeline.",
});

export type OrderTypingStartedV1Payload = z.infer<typeof payloadSchema>;
