// order.final.started.v1 — pharmacist claimed the order for FINAL verification.
//
// Producer: `StartFinalVerification` (`@pharmax/verification`).
// Consumers: SLA timer (closes WAIT_BEFORE_FINAL_VERIFICATION /
//   opens FINAL_VERIFICATION_ACTIVE); queue-counter dashboard.

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

export const OrderFinalStartedV1 = defineEvent({
  name: "order.final.started",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by StartFinalVerification when a pharmacist claims the order for the final safety check. Closes WAIT_BEFORE_FINAL_VERIFICATION / opens FINAL_VERIFICATION_ACTIVE on the SLA timeline.",
});

export type OrderFinalStartedV1Payload = z.infer<typeof payloadSchema>;
