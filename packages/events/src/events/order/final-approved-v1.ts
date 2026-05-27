// order.final.approved.v1 — pharmacist approved final verification.
//
// Producer: `ApproveFinalVerification` (`@pharmax/verification`).
// Consumers: SLA timer (closes FINAL_VERIFICATION_ACTIVE / opens
//   WAIT_BEFORE_SHIPPING).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    approvingPharmacistUserId: z.uuid(),
    bucketId: z.uuid(),
    transitionId: z.string().min(1),
    fromState: z.string().min(1),
    toState: z.string().min(1),
    verificationRecordId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderFinalApprovedV1 = defineEvent({
  name: "order.final.approved",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by ApproveFinalVerification — the order is now ready for shipping release. Closes FINAL_VERIFICATION_ACTIVE on the SLA timeline.",
});

export type OrderFinalApprovedV1Payload = z.infer<typeof payloadSchema>;
