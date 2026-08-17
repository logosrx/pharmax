// patient.registered.v1 — a new patient row was created.
//
// Producer: `RegisterPatient` command (`@pharmax/patients`).
// Consumers: none yet (downstream notifications and intake-status
//   counters will subscribe).
//
// PHI classification: PHI-BEARING (`phiSafe: false`).
//
// Names, DOB and addresses are absent — they live only in the
// encrypted columns on the patient row, and that part of the design
// is unchanged. What makes this payload PHI is what remains: a
// persistent `patientId` bound to a `clinicId`. "This individual is
// a patient of this clinic" is the provision of health care to an
// individual under 45 CFR §160.103, and the id is an identifier
// under §164.514(b)(2)(i)(R) — so stripping the name does not
// de-identify the record, it only makes it look de-identified.
//
// Consequence: this event is not partner-webhook eligible. A
// consumer that needs it reads the patient row under tenancy, which
// leaves an audit entry. Delivering it to an external subscriber
// requires an executed BAA and a disclosure record first.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    patientId: z.uuid(),
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PatientRegisteredV1 = defineEvent({
  name: "patient.registered",
  version: 1,
  aggregateType: "Patient",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.patientId,
  owner: "patients",
  retention: "7y",
  phiSafe: false,
  routingKey: "patient.roster",
  description:
    "Emitted by RegisterPatient after the encrypted patient row + blind-index columns are persisted. Carries ids only — no names, DOB or addresses — but the patient/clinic pairing is itself PHI, so the event is PHI-bearing and not webhook-eligible.",
});

export type PatientRegisteredV1Payload = z.infer<typeof payloadSchema>;
