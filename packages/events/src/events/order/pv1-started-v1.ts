// order.pv1.started.v1 — pharmacist claimed the order for PV1 review.
//
// Producer: `StartPV1` (`@pharmax/verification`).
// Consumers: SLA timer (closes WAIT_BEFORE_PV1 / opens PV1_ACTIVE);
//   queue-counter dashboard.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    pharmacistUserId: z.uuid(),
    bucketId: z.uuid(),
    transitionId: z.string().min(1),
    fromState: z.string().min(1),
    toState: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderPv1StartedV1 = defineEvent({
  name: "order.pv1.started",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by StartPV1 when a pharmacist claims the order for first-pharmacist verification. Closes WAIT_BEFORE_PV1 / opens PV1_ACTIVE on the SLA timeline.",
});

export type OrderPv1StartedV1Payload = z.infer<typeof payloadSchema>;
