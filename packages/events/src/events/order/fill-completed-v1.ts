// order.fill.completed.v1 — fill tech finished filling the order.
//
// Producer: `CompleteFill` (`@pharmax/fill`).
// Consumers: SLA timer (closes FILL_ACTIVE / opens
//   WAIT_BEFORE_FINAL_VERIFICATION); SoD anchor for
//   `ApproveFinalVerification` (`sod.fill-final-same-actor` rule).

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

export const OrderFillCompletedV1 = defineEvent({
  name: "order.fill.completed",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "fill",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by CompleteFill after every order line has a lot assignment + completed vial-label print. Closes FILL_ACTIVE on the SLA timeline and is the SoD anchor for the fill-then-final-same-actor rule.",
});

export type OrderFillCompletedV1Payload = z.infer<typeof payloadSchema>;
