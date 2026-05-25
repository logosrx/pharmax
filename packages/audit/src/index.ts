// @pharmax/audit — public API.
//
// Tamper-evident audit chain. Every row in `audit_log` is linked to
// the previous row in its tenant's chain via a SHA-256 hash; the
// per-tenant chain head is tracked in `audit_chain_state`. Writers
// must go through `writeAuditLogInTx` so the chain invariant is
// maintained; verifiers use `verifyChain` to re-derive the chain and
// detect tampering.
//
// What's exported:
//
//   - Writer: `writeAuditLogInTx`.
//   - Verifier: `verifyChain` + `ChainSource`.
//   - Pure helpers: `computeAuditEntryHash`, `canonicalEncodeAuditEntry`.
//   - Types: `CanonicalAuditEntry`, `WriteAuditLogInput`,
//     `WriteAuditLogOutput`, `AuditChainTxClient`, `AuditChainRow`.
//   - Errors: codes + factory helpers.
//
// What's intentionally NOT exported:
//
//   - The Postgres advisory-lock key derivation — lives in SQL.
//   - The TLV field-tag constants (TAG_*). Those are an implementation
//     detail of the encoder format; cross-process verifiers re-import
//     them through `chain/encoder.js` directly. Hiding them from the
//     public surface keeps the encoder free to renumber additions.

export {
  canonicalEncodeAuditEntry,
  computeAuditEntryHash,
  type CanonicalAuditEntry,
} from "./chain/encoder.js";

export {
  writeAuditLogInTx,
  type AuditChainTxClient,
  type WriteAuditLogInput,
  type WriteAuditLogOutput,
} from "./chain/writer.js";

export {
  verifyChain,
  type ChainSource,
  type AuditChainRow,
  type VerifyResult,
} from "./chain/verifier.js";

export {
  AUDIT_CHAIN_BROKEN,
  AUDIT_LOCK_UNAVAILABLE,
  AUDIT_NOT_IN_TRANSACTION,
  AUDIT_VALIDATION,
  auditChainBrokenError,
  auditLockUnavailableError,
  auditNotInTransactionError,
  auditValidationError,
} from "./errors.js";
