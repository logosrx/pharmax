// order.pv1.rejected.v1 — pharmacist rejected PV1; bounces back to typing.
//
// Producer: `RejectPV1` (`@pharmax/verification`).
// Consumers: SLA timer (closes PV1_ACTIVE / opens
//   WAIT_AFTER_PV1_REJECT); typist-rework dashboard; future
//   ORDER_PV1_REJECTED_V1 notification.
//
// PHI: none. Reason is a closed code; any free-text reason note
// lives on the encrypted `verification_record.reasonText` column,
// never in this payload.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const PV1_REJECTION_REASONS = [
  "DOSE_INCORRECT",
  "SIG_AMBIGUOUS",
  "MISSING_INFO",
  "DATA_ENTRY_ERROR",
  "DRUG_INTERACTION",
  "ALLERGY_CONFLICT",
  "DUPLICATE_THERAPY",
  "PRESCRIBER_VERIFICATION_NEEDED",
  "INSURANCE_PRIOR_AUTH_REQUIRED",
  "DRUG_UNAVAILABLE",
  "OTHER",
] as const;

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    rejectingPharmacistUserId: z.uuid(),
    bucketId: z.uuid(),
    transitionId: z.string().min(1),
    fromState: z.string().min(1),
    toState: z.string().min(1),
    reasonCode: z.enum(PV1_REJECTION_REASONS),
    verificationRecordId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderPv1RejectedV1 = defineEvent({
  name: "order.pv1.rejected",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by RejectPV1 when a pharmacist refuses to approve typed review and bounces the order back to the typing queue. Triggers typist-rework notifications.",
});

export type OrderPv1RejectedV1Payload = z.infer<typeof payloadSchema>;
