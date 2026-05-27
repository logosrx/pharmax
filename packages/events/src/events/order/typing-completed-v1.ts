// order.typing.completed.v1 — typing review finished; order ready for PV1.
//
// Producer: `CompleteTypingReview` (`@pharmax/verification`).
// Consumers: SLA timer (closes TYPING_ACTIVE, opens WAIT_BEFORE_PV1).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    completedByUserId: z.uuid(),
    bucketId: z.uuid(),
    transitionId: z.string().min(1),
    fromState: z.string().min(1),
    toState: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderTypingCompletedV1 = defineEvent({
  name: "order.typing.completed",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by CompleteTypingReview after the order moves to TYPED_READY_FOR_PV1. Closes TYPING_ACTIVE / opens WAIT_BEFORE_PV1 on the SLA timeline.",
});

export type OrderTypingCompletedV1Payload = z.infer<typeof payloadSchema>;
