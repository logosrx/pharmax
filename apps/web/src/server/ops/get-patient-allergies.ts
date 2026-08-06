// The allergy profile for the ops console.
//
// A thin tenant-scoped wrapper over `getPatientAllergyProfile` in
// `@pharmax/patients`, which is where the projection and the decryption
// live. Kept as its own module so both surfaces that need it — the
// patient-detail page and the PV1 order-detail page — open the read the
// same way.
//
// PHI: this DECRYPTS the narrative columns. Callers must be gated on
// `patients.allergies.read` and must already have written a PHI-view
// audit entry for the surface they are rendering — which both call sites
// do, via `auditPatientView`, before rendering anything.

import "server-only";

import { readInOrgScope } from "@pharmax/database";
import { getPatientAllergyProfile, type PatientAllergyProfile } from "@pharmax/patients";

export type { PatientAllergyProfile } from "@pharmax/patients";

export async function getPatientAllergies(input: {
  readonly organizationId: string;
  readonly patientId: string;
}): Promise<PatientAllergyProfile> {
  return await readInOrgScope(input.organizationId, (tx) =>
    getPatientAllergyProfile({
      tx,
      organizationId: input.organizationId,
      patientId: input.patientId,
    })
  );
}
