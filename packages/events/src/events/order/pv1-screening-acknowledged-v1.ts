// order.pv1.screening.acknowledged.v1 — a pharmacist recorded their
// judgement on one screening finding.
//
// Producer: `AcknowledgePV1ScreeningFinding` (`@pharmax/verification`).
// Consumers: the PV1 console (marks the finding settled for this
//   pharmacist); override-rate reporting, which is the honest measure
//   of whether the acknowledge tier is earning its interruptions.
//
// `pharmacistUserId` is not incidental metadata here — it is the
// substance of the event. The acknowledgement satisfies ApprovePV1's
// gate only for this person, so a consumer reconstructing "was this
// approval properly gated?" needs the actor as much as the
// fingerprint.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    pharmacistUserId: z.uuid(),
    fingerprint: z.string().min(1),
    findingCode: z.string().min(1),
    severity: z.string().min(1),
    certainty: z.string().min(1),
    workflowPolicyId: z.uuid(),
    workflowPolicyVersion: z.number().int().positive(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderPv1ScreeningAcknowledgedV1 = defineEvent({
  name: "order.pv1.screening.acknowledged",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by AcknowledgePV1ScreeningFinding when a pharmacist records their judgement on a screening finding. The acknowledgement satisfies ApprovePV1's gate only for the pharmacist who gave it.",
});

export type OrderPv1ScreeningAcknowledgedV1Payload = z.infer<typeof payloadSchema>;
