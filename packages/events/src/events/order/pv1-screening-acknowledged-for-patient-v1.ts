// order.pv1.screening.acknowledged_for_patient.v1 — a pharmacist
// recorded their judgement on one PATIENT-RECORD screening gap, filed
// against the PATIENT rather than the order.
//
// Producer: `AcknowledgePV1ScreeningFinding` (`@pharmax/verification`),
//   when the persisted finding classifies as a per-subject record gap
//   (today exactly SCR_ALLERGY_INPUT_UNAVAILABLE — "no allergy history
//   is recorded for this patient"). The command decides the scope from
//   the finding row; no caller input can choose it.
// Consumers: the PV1 console (renders "acknowledged for this patient"
//   coverage on the patient's other orders); override-rate reporting,
//   where the split from `order.pv1.screening.acknowledged.v1` is the
//   measure of how much per-refill re-acknowledgement noise this
//   scope removed.
//
// `recordStateToken` is the substance of the re-arming design: the
// judgement binds to the hash of the patient's allergy-record state
// at the moment it was given, and the approval gate honors it only
// while the record still hashes to the same value. A consumer
// reconstructing "why was this pharmacist not prompted in March, and
// why were they prompted again in May?" needs the token the March
// coverage was standing on.
//
// PHI: none. The token is a SHA-256 over record ids and coded
// statuses — it names no substance and carries no narrative. The
// patientId is the same opaque identifier the patient-allergy events
// already carry.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    patientId: z.uuid(),
    pharmacistUserId: z.uuid(),
    /** The PER_SUBJECT screening axis whose record gap this settles. */
    axis: z.string().min(1),
    fingerprint: z.string().min(1),
    findingCode: z.string().min(1),
    severity: z.string().min(1),
    certainty: z.string().min(1),
    recordStateToken: z.string().min(1),
    workflowPolicyId: z.uuid(),
    workflowPolicyVersion: z.number().int().positive(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderPv1ScreeningAcknowledgedForPatientV1 = defineEvent({
  name: "order.pv1.screening.acknowledged_for_patient",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by AcknowledgePV1ScreeningFinding when a pharmacist records their judgement on a patient-record screening gap. The acknowledgement covers this pharmacist across the patient's orders while the patient's record state still hashes to recordStateToken; a change to the record re-arms the prompt.",
});

export type OrderPv1ScreeningAcknowledgedForPatientV1Payload = z.infer<typeof payloadSchema>;
