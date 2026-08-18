// patient.allergy.recorded.v1 — an allergy or intolerance was added to
// a patient's profile.
//
// Producer: `RecordPatientAllergy` command (`@pharmax/patients`).
// Consumers: none yet. The obvious first one is a re-screen nudge —
//   recording an allergy for a patient with an order already in PV1
//   means the pharmacist is looking at a screen that predates the fact.
//
// PHI classification: PHI-BEARING (`phiSafe: false`).
//
// Withholding the substance (below) reduces the clinical detail but
// does not de-identify the payload. `patientId` is an identifier
// under 45 CFR §164.514(b)(2)(i)(R), and `category` + `criticality` +
// `verificationStatus` still state a health condition about the
// individual it resolves to: "this patient has a confirmed,
// high-criticality medication allergy." That is PHI with or without
// the allergen named, so the event is not webhook-eligible.
//
// WHAT IS NOT HERE, and why. The substance code is deliberately absent.
// Every other coded value on this payload is structural — it says what
// KIND of thing was recorded, which is what a consumer routes and
// counts on. The substance says WHICH allergen a named patient reacts
// to, and pairing it with `patientId` in a payload that lands in
// `event_outbox`, the webhook fan-out, and every subscriber's log is a
// clinical detail crossing a boundary no consumer has asked to cross.
// A consumer that genuinely needs the substance reads the row under
// tenancy with `patients.allergies.read`, which leaves an audit entry —
// which is the point.
//
// `screenable` is the one derived field, and it is here because it is
// the only thing on the row that decides whether PV1 screening changed
// behaviour. A record that is not screenable (uncoded substance, food
// category) is a real clinical record that the engine cannot use, and a
// consumer counting "allergy coverage" that could not tell the
// difference would report coverage the screen does not have.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    allergyId: z.uuid(),
    patientId: z.uuid(),
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    category: z.enum(["MEDICATION", "BIOLOGIC", "FOOD", "ENVIRONMENT"]),
    type: z.enum(["ALLERGY", "INTOLERANCE"]),
    criticality: z.enum(["HIGH", "LOW", "UNABLE_TO_ASSESS"]),
    verificationStatus: z.enum(["CONFIRMED", "UNCONFIRMED", "REFUTED", "ENTERED_IN_ERROR"]),
    substanceCodeSystem: z.enum([
      "RXNORM",
      "NDC",
      "SNOMED_CT",
      "PHARMAX_ALLERGEN_CLASS",
      "UNCODED",
    ]),
    /**
     * Whether the PV1 screening engine can actually use this record.
     * False for an uncoded substance or a category no drug knowledge
     * base can answer.
     */
    screenable: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PatientAllergyRecordedV1 = defineEvent({
  name: "patient.allergy.recorded",
  version: 1,
  aggregateType: "Patient",
  schema: payloadSchema,
  // Keyed on the PATIENT, not the allergy: the allergy profile is the
  // aggregate a consumer cares about ordering, and three allergies
  // recorded in one intake session should stay in sequence.
  aggregateIdFrom: (p) => p.patientId,
  owner: "patients",
  retention: "7y",
  phiSafe: false,
  routingKey: "patient.allergy",
  description:
    "Emitted by RecordPatientAllergy after the row is persisted. Carries ids and the coded structural fields (category, type, criticality, verification status, code system) plus whether the record is usable by PV1 screening. The substance itself is deliberately omitted — read the row under tenancy for that.",
});

export type PatientAllergyRecordedV1Payload = z.infer<typeof payloadSchema>;
