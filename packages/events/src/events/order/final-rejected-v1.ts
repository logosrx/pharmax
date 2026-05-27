// order.final.rejected.v1 — pharmacist rejected final verification.
//
// Producer: `RejectFinalVerification` (`@pharmax/verification`).
// Consumers: SLA timer (closes FINAL_VERIFICATION_ACTIVE / opens
//   WAIT_AFTER_FINAL_REJECT); fill-rework dashboard; future
//   ORDER_FINAL_REJECTED_V1 notification.
//
// PHI: none. Closed reason code; any free-text reason note lives
// on the encrypted `verification_record.reasonText` column, never
// in this payload.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const FINAL_REJECTION_REASONS = [
  "WRONG_DRUG_PULLED",
  "WRONG_STRENGTH",
  "WRONG_QUANTITY",
  "LABEL_INCORRECT",
  "LABEL_DAMAGED",
  "EXPIRED_LOT_ASSIGNED",
  "HELD_LOT_ASSIGNED",
  "MISSING_AUXILIARY_LABEL",
  "VIAL_INTEGRITY",
  "WRONG_PATIENT_ASSIGNED",
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
    reasonCode: z.enum(FINAL_REJECTION_REASONS),
    verificationRecordId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderFinalRejectedV1 = defineEvent({
  name: "order.final.rejected",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by RejectFinalVerification when a pharmacist refuses to release a filled vial and bounces the order back to FILL for rework. Triggers fill-rework notifications.",
});

export type OrderFinalRejectedV1Payload = z.infer<typeof payloadSchema>;
