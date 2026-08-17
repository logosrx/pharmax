// patient.updated.v1 — a patient row's encrypted columns were mutated.
//
// Producer: `UpdatePatient` (`@pharmax/patients`).
// Consumers: future patient-summary projection; access-pattern audit.
//
// PHI classification: PHI-BEARING (`phiSafe: false`). The payload
// still carries ONLY the LIST of field NAMES that changed, never the
// new values — that part of the construction holds, and the plaintext
// stays in the encrypted columns for consumers to decrypt via
// `@pharmax/crypto` under proper tenancy.
//
// It is nonetheless PHI. The field names are drawn from
// `PATIENT_PHI_FIELD_NAMES` and are reported against a `patientId`,
// an identifier under 45 CFR §164.514(b)(2)(i)(R). A subscriber
// learns that a specific individual is a patient here and which of
// their identifiers just changed — enough to track a person across
// updates. Not partner-webhook eligible.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

/**
 * Domain-level set of PHI-bearing field names that
 * `UpdatePatient` knows how to write. Kept in lock-step with the
 * `redactFields` list in `UpdatePatient` and the encrypted columns
 * on the `patient` row.
 */
const PATIENT_PHI_FIELD_NAMES = [
  "firstName",
  "middleName",
  "lastName",
  "preferredName",
  "dateOfBirth",
  "sexAtBirth",
  "ssnLast4",
  "phone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "mrn",
] as const;

const payloadSchema = z
  .object({
    patientId: z.uuid(),
    organizationId: z.uuid(),
    /**
     * Names of PHI fields that received a NEW non-null value in
     * this update. The values themselves are absent.
     */
    updatedFields: z.array(z.enum(PATIENT_PHI_FIELD_NAMES)),
    /**
     * Names of PHI fields that were CLEARED in this update.
     * Disjoint from `updatedFields`.
     */
    clearedFields: z.array(z.enum(PATIENT_PHI_FIELD_NAMES)),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PatientUpdatedV1 = defineEvent({
  name: "patient.updated",
  version: 1,
  aggregateType: "Patient",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.patientId,
  owner: "patients",
  retention: "7y",
  phiSafe: false,
  routingKey: "patient.roster",
  description:
    "Emitted by UpdatePatient after the encrypted columns are mutated. Carries only field-name lists — never plaintext PHI.",
});

export type PatientUpdatedV1Payload = z.infer<typeof payloadSchema>;
