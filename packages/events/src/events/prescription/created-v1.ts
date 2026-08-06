// prescription.created.v1 — a prescription was transcribed into the
// system.
//
// Producer: `CreatePrescription` command (`@pharmax/orders`).
// Consumers: none yet. The obvious first ones are the controlled-
//   substance reporting projection (PDMP submission needs to know a
//   CII/CIII/CIV/CV prescription exists before it is ever dispensed)
//   and the clinic-facing activity feed.
//
// PHI invariant: this payload is PHI-FREE. The directions for use
// (`sig`), the note to the pharmacist, the note to the patient and
// the indication all live ONLY in the encrypted columns on the
// prescription row and never appear here.
//
// `drugNdc` and `controlledSubstanceSchedule` ARE carried, following
// the precedent set by `AddPrescription`'s audit metadata: an NDC
// keyed to an id is catalog data, not patient data, and a consumer
// that needs to know "is this a controlled substance?" should not
// have to decrypt anything to find out. The patient is referenced by
// id only, so the payload identifies a drug and a row, never a
// person and their medication together in plaintext.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    prescriptionId: z.uuid(),
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    patientId: z.uuid(),
    providerId: z.uuid(),
    drugNdc: z.string().min(1),
    controlledSubstanceSchedule: z.enum(["NON_CONTROLLED", "CII", "CIII", "CIV", "CV"]),
    refillsAuthorized: z.int().nonnegative(),
    daysSupply: z.int().positive(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PrescriptionCreatedV1 = defineEvent({
  name: "prescription.created",
  version: 1,
  aggregateType: "Prescription",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.prescriptionId,
  owner: "orders",
  retention: "7y",
  phiSafe: true,
  routingKey: "prescription.lifecycle",
  description:
    "Emitted by CreatePrescription once the encrypted sig and the blind-indexed Rx number are persisted. Carries ids, the NDC and the schedule snapshot — never the directions for use.",
});

export type PrescriptionCreatedV1Payload = z.infer<typeof payloadSchema>;
