// order.pv1.approved.v1 — pharmacist approved PV1; order ready for fill.
//
// Producer: `ApprovePV1` (`@pharmax/verification`).
// Consumers: SLA timer (closes PV1_ACTIVE / opens WAIT_BEFORE_FILL),
//   future fill-queue dashboard.

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

export const OrderPv1ApprovedV1 = defineEvent({
  name: "order.pv1.approved",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by ApprovePV1 after the pharmacist signs off on typing. Anchors the SoD check that ApproveFinalVerification runs against (no PV1+Final by the same actor).",
});

export type OrderPv1ApprovedV1Payload = z.infer<typeof payloadSchema>;
