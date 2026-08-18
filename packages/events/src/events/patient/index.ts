// Per-domain barrel for patient.* event definitions.

export { PatientAllergyHistoryAssertedV1 } from "./allergy-history-asserted-v1.js";
export { PatientAllergyRecordedV1 } from "./allergy-recorded-v1.js";
export { PatientAllergyStatusAmendedV1 } from "./allergy-status-amended-v1.js";
export { PatientCryptoShreddedV1 } from "./crypto-shredded-v1.js";
export { PatientRegisteredV1 } from "./registered-v1.js";
export { PatientUpdatedV1 } from "./updated-v1.js";
// NOTE: this barrel is enumerated with `Object.values()` by
// `index.test.ts` and by the registry parity guard, so it must export
// event definitions and nothing else. `PATIENT_VIEW_SURFACES` is
// exported from the package root instead.
export { PatientViewedV1 } from "./viewed-v1.js";
