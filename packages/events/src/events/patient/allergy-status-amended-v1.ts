// patient.allergy.status.amended.v1 — a recorded allergy's clinical or
// verification status changed.
//
// Producer: `AmendPatientAllergyStatus` command (`@pharmax/patients`).
// Consumers: none yet.
//
// This is the retraction path, and it is an event rather than a silent
// UPDATE because it is the one edit that can switch a safety check off.
// Both the previous and the new status are on the payload: "this
// allergy is now refuted" is far less useful six months later than
// "this allergy went from CONFIRMED to REFUTED", and reconstructing the
// previous value from an event stream a consumer may have joined late
// is not something a consumer should have to do.
//
// PHI classification: PHI-BEARING (`phiSafe: false`). The reason stays
// a code from a closed list rather than the operator's free text — see
// `ALLERGY_STATUS_CHANGE_REASONS` — and no allergen is named. What
// makes this PHI is the pairing: coded clinical statuses, before and
// after, against a `patientId`, which is an identifier under 45 CFR
// §164.514(b)(2)(i)(R). "This patient's allergy was refuted" is a
// statement about their health, so the event is not webhook-eligible.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const clinicalStatus = z.enum(["ACTIVE", "INACTIVE", "RESOLVED"]);
const verificationStatus = z.enum(["CONFIRMED", "UNCONFIRMED", "REFUTED", "ENTERED_IN_ERROR"]);

const payloadSchema = z
  .object({
    allergyId: z.uuid(),
    patientId: z.uuid(),
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    previousClinicalStatus: clinicalStatus,
    clinicalStatus,
    previousVerificationStatus: verificationStatus,
    verificationStatus,
    reasonCode: z.string().min(1).max(64),
    /**
     * Whether the record still counts as screenable input AFTER the
     * amendment. The single most consequential fact about a status
     * change, and the reason `previous*` fields are carried: a consumer
     * can see that a patient's only screenable allergy just stopped
     * being one.
     */
    screenable: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PatientAllergyStatusAmendedV1 = defineEvent({
  name: "patient.allergy.status.amended",
  version: 1,
  aggregateType: "Patient",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.patientId,
  owner: "patients",
  retention: "7y",
  phiSafe: false,
  routingKey: "patient.allergy",
  description:
    "Emitted by AmendPatientAllergyStatus. Carries the previous AND new clinical/verification status, the reason code, and whether the record is still usable by PV1 screening. The retraction path for an allergy entered in error — the row is never deleted.",
});

export type PatientAllergyStatusAmendedV1Payload = z.infer<typeof payloadSchema>;
