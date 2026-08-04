// Public surface of @pharmax/patients.
//
// Domain package convention (mirrors @pharmax/orgs):
//   - Commands are exported individually AND under a `commands`
//     namespace for ergonomic batch imports.
//   - Each command file owns its input/output types and is the only
//     place that imports `@pharmax/crypto` for that aggregate's PHI.
//   - Future patient aggregates (MergePatients) land alongside
//     RegisterPatient/UpdatePatient/CryptoShredPatient in
//     `src/commands/` and re-export here.
//
// The package also ships read-path primitives — redaction projection,
// blind-index search helpers, and a narrow id-based repository — so
// any caller that needs to project, search, or look up patients goes
// through one place instead of reinventing the rules.

export type {
  PatientPlaintext,
  PatientSearchQuery,
  PatientSearchResult,
  RedactedPatient,
} from "./types.js";

export {
  PATIENT_REDACTED_FIELD_NAMES,
  redactPatient,
  type RedactablePatient,
} from "./redact-patient.js";

export {
  PATIENT_BLIND_INDEX,
  normalizeDobForBlindIndex,
  normalizeDobYearMonthForBlindIndex,
} from "./blind-indexes.js";

export {
  DEFAULT_PATIENT_SEARCH_LIMIT,
  MAX_PATIENT_SEARCH_LIMIT,
  buildSearchWhere,
  searchPatients,
  type PatientSearchOptions,
} from "./search-patients.js";

export { PatientRepository, type PatientRepositoryListOptions } from "./patient-repository.js";

export {
  RegisterPatient,
  type RegisterPatientInput,
  type RegisterPatientOutput,
} from "./commands/register-patient.js";

export {
  UpdatePatient,
  type UpdatePatientInput,
  type UpdatePatientOutput,
} from "./commands/update-patient.js";

export {
  CryptoShredPatient,
  type CryptoShredPatientInput,
  type CryptoShredPatientOutput,
} from "./commands/crypto-shred-patient.js";

export {
  ViewPatient,
  PATIENT_NOT_FOUND,
  VIEW_PATIENT_SURFACES,
  type ViewPatientInput,
  type ViewPatientOutput,
  type ViewPatientSurface,
} from "./commands/view-patient.js";

export {
  assertsEmptyAllergyHistory,
  isScreenableAllergyRow,
  loadAllergyHistoryState,
  ALLERGY_RETIRING_CLINICAL_STATUSES,
  ALLERGY_RETRACTING_VERIFICATION_STATUSES,
  ALLERGY_STATUS_CHANGE_REASONS,
  ALLERGY_STATUS_CHANGE_REASON_CODES,
  type AllergyHistoryState,
  type AllergyScreenabilityRow,
  type AllergyStatusChangeReason,
  type PatientAllergyView,
} from "./allergies.js";

export {
  RecordPatientAllergy,
  ALLERGY_PATIENT_NOT_FOUND,
  ALLERGY_PATIENT_SHREDDED,
  type RecordPatientAllergyInput,
  type RecordPatientAllergyOutput,
} from "./commands/record-patient-allergy.js";

export {
  AmendPatientAllergyStatus,
  ALLERGY_NOT_FOUND,
  ALLERGY_STATUS_UNCHANGED,
  type AmendPatientAllergyStatusInput,
  type AmendPatientAllergyStatusOutput,
} from "./commands/amend-patient-allergy-status.js";

export {
  AssertPatientAllergyHistory,
  ALLERGY_HISTORY_ASSERTED_IN_FUTURE,
  ALLERGY_HISTORY_ASSERTED_TOO_LONG_AGO,
  ALLERGY_HISTORY_PATIENT_NOT_FOUND,
  MAX_ALLERGY_HISTORY_BACKFILL_DAYS,
  type AssertPatientAllergyHistoryInput,
  type AssertPatientAllergyHistoryOutput,
} from "./commands/assert-patient-allergy-history.js";

export { getPatientAllergyProfile, type PatientAllergyProfile } from "./patient-allergy-profile.js";

import * as allergiesModule from "./allergies.js";
import * as blindIndexesModule from "./blind-indexes.js";
import * as amendPatientAllergyStatusModule from "./commands/amend-patient-allergy-status.js";
import * as assertPatientAllergyHistoryModule from "./commands/assert-patient-allergy-history.js";
import * as cryptoShredPatientModule from "./commands/crypto-shred-patient.js";
import * as recordPatientAllergyModule from "./commands/record-patient-allergy.js";
import * as registerPatientModule from "./commands/register-patient.js";
import * as updatePatientModule from "./commands/update-patient.js";
import * as viewPatientModule from "./commands/view-patient.js";
import * as patientRepositoryModule from "./patient-repository.js";
import * as redactPatientModule from "./redact-patient.js";
import * as searchPatientsModule from "./search-patients.js";

export const patients = {
  ...redactPatientModule,
  ...blindIndexesModule,
  ...searchPatientsModule,
  ...patientRepositoryModule,
  ...allergiesModule,
  commands: {
    RegisterPatient: registerPatientModule.RegisterPatient,
    UpdatePatient: updatePatientModule.UpdatePatient,
    CryptoShredPatient: cryptoShredPatientModule.CryptoShredPatient,
    ViewPatient: viewPatientModule.ViewPatient,
    RecordPatientAllergy: recordPatientAllergyModule.RecordPatientAllergy,
    AmendPatientAllergyStatus: amendPatientAllergyStatusModule.AmendPatientAllergyStatus,
    AssertPatientAllergyHistory: assertPatientAllergyHistoryModule.AssertPatientAllergyHistory,
  },
} as const;
