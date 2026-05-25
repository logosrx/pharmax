// Public surface of the PHI registry helpers under @pharmax/database.
//
// These are intentionally documentation-grade artifacts: they don't
// touch the database, they don't perform encryption. They name the
// (table, column) bindings and blind-index purposes that schema-aware
// callers (repositories, KMS rotation jobs, tests) need to agree on.

export {
  ALL_BLIND_INDEX_BINDINGS,
  PATIENT_BLIND_INDEX_BINDINGS,
  PRESCRIPTION_BLIND_INDEX_BINDINGS,
  type BlindIndexBinding,
} from "./blind-index-purposes.js";
