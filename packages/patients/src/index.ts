// Public surface of @pharmax/patients.
//
// Domain package convention (mirrors @pharmax/orgs):
//   - Commands are exported individually AND under a `commands`
//     namespace for ergonomic batch imports.
//   - Each command file owns its input/output types and is the only
//     place that imports `@pharmax/crypto` for that aggregate's PHI.
//   - Future patient aggregates (UpdatePatient, MergePatients,
//     CryptoShredPatient) land alongside RegisterPatient in
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

import * as blindIndexesModule from "./blind-indexes.js";
import * as registerPatientModule from "./commands/register-patient.js";
import * as patientRepositoryModule from "./patient-repository.js";
import * as redactPatientModule from "./redact-patient.js";
import * as searchPatientsModule from "./search-patients.js";

export const patients = {
  ...redactPatientModule,
  ...blindIndexesModule,
  ...searchPatientsModule,
  ...patientRepositoryModule,
  commands: {
    RegisterPatient: registerPatientModule.RegisterPatient,
  },
} as const;
