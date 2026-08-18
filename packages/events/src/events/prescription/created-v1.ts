// prescription.created.v1 — a prescription was transcribed into the
// system.
//
// Producer: `CreatePrescription` command (`@pharmax/orders`).
// Consumers: none yet. The obvious first ones are the controlled-
//   substance reporting projection (PDMP submission needs to know a
//   CII/CIII/CIV/CV prescription exists before it is ever dispensed)
//   and the clinic-facing activity feed.
//
// PHI classification: PHI-BEARING (`phiSafe: false`).
//
// The free text is still absent and still belongs only in the
// encrypted columns: the directions for use (`sig`), the note to the
// pharmacist, the note to the patient, and the indication never
// appear here.
//
// This event was previously classified PHI-free on the reasoning
// that "an NDC keyed to an id is catalog data, not patient data —
// the payload identifies a drug and a row, never a person and their
// medication together." That reasoning does not survive contact with
// §164.514(b). `patientId` is a unique identifying code under
// (b)(2)(i)(R), so a row keyed by it is not de-identified; and the
// payload does put a person and their medication together, because
// the id resolves to the person for anyone holding the mapping —
// which every recipient of `patient.registered.v1` does. Pairing it
// with `drugNdc`, `controlledSubstanceSchedule` and `daysSupply`
// yields a medication profile for an identifiable individual.
//
// The fields stay: an internal consumer genuinely should not decrypt
// anything to answer "is this a controlled substance?". What changes
// is that this event may no longer leave the platform. Partner
// delivery requires an executed BAA and a disclosure record.

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
  phiSafe: false,
  routingKey: "prescription.lifecycle",
  description:
    "Emitted by CreatePrescription once the encrypted sig and the blind-indexed Rx number are persisted. Carries ids, the NDC and the schedule snapshot — never the directions for use. PHI-bearing: patientId plus drug identity is a medication profile for an identifiable individual, so the event is not webhook-eligible.",
});

export type PrescriptionCreatedV1Payload = z.infer<typeof payloadSchema>;
