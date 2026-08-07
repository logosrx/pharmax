// patient.allergy_history.asserted.v1 — somebody took an allergy
// history and stated the result.
//
// Producer: `AssertPatientAllergyHistory` command (`@pharmax/patients`).
// Consumers: none yet.
//
// The event that makes "no known allergies" a fact with an owner. A
// NO_KNOWN_ALLERGIES assertion is what lets the PV1 allergy axis screen
// CLEAR for a patient with no allergy rows, so it is exactly the
// statement that must be attributable years later. UNABLE_TO_ASSESS is
// the honest alternative and deliberately does NOT open the axis.
//
// PHI invariant: PHI-FREE. Ids, one enum, and timestamps.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    assertionId: z.uuid(),
    patientId: z.uuid(),
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    status: z.enum(["NO_KNOWN_ALLERGIES", "UNABLE_TO_ASSESS"]),
    /**
     * When the history was TAKEN, which is not necessarily when the row
     * was written — backfilling a history taken at the clinic yesterday
     * is legitimate, and the clinical time is the one that matters.
     */
    assertedAt: z.iso.datetime({ offset: true }),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PatientAllergyHistoryAssertedV1 = defineEvent({
  name: "patient.allergy_history.asserted",
  version: 1,
  aggregateType: "Patient",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.patientId,
  owner: "patients",
  retention: "7y",
  phiSafe: true,
  routingKey: "patient.allergy",
  description:
    "Emitted by AssertPatientAllergyHistory. Records that an allergy history was taken and what it found: NO_KNOWN_ALLERGIES (which is what lets the PV1 allergy axis report clear) or UNABLE_TO_ASSESS (which does not). Append-only; a later assertion supersedes but does not erase.",
});

export type PatientAllergyHistoryAssertedV1Payload = z.infer<typeof payloadSchema>;
