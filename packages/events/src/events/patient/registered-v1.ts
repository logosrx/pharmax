// patient.registered.v1 — a new patient row was created.
//
// Producer: `RegisterPatient` command (`@pharmax/patients`).
// Consumers: none yet (downstream notifications and intake-status
//   counters will subscribe).
//
// PHI invariant: this payload is PHI-FREE. Patient names, DOB,
// addresses, etc. live ONLY in the encrypted columns on the
// patient row. The payload carries ids and a timestamp so
// downstream consumers can correlate to the patient row via a
// tenancy-scoped read; consumers that need PHI are responsible
// for decrypting via `@pharmax/crypto`.

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
  phiSafe: true,
  routingKey: "patient.roster",
  description:
    "Emitted by RegisterPatient after the encrypted patient row + blind-index columns are persisted. Carries only ids — never PHI.",
});

export type PatientRegisteredV1Payload = z.infer<typeof payloadSchema>;
