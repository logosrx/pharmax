// @pharmax/audit error codes.
//
// The chain writer fails into two operational buckets:
//
//   - **Validation** (4xx-class): the caller supplied a malformed entry
//     (empty action, NUL byte, sequence-number mismatch). Treat as
//     a programming error — the bus already validates command shape,
//     so any AUDIT_VALIDATION reaching production means a writer-side
//     bug. Throw, audit at the caller's discretion.
//
//   - **Chain integrity** (5xx-class): a verifier ran across audit_log
//     and found a row whose recomputed entryHash does not match the
//     stored value, or a row whose prevHash does not match the prior
//     row's entryHash. This is a SECURITY page — it means audit_log
//     was mutated outside the writer (DBA, dropped REVOKE, RLS bug)
//     or a row was deleted. AUDIT_CHAIN_BROKEN is the loudest possible
//     incident signal in this codebase short of a PHI leak.
//
//   - **Lock acquisition** (5xx-class): the writer's per-tenant
//     advisory lock could not be acquired. In practice this is
//     impossible inside a transaction (pg_advisory_xact_lock waits),
//     but we expose the code in case future configurations switch
//     to try-lock semantics.
//
// PHI invariant: error metadata is limited to organizationId, seq,
// resource type/id, and chain hashes (hex-encoded). The action verb
// and metadata blob from the offending audit row are NEVER surfaced
// in errors — they might quote PHI from a reason code or scope.

import { errors } from "@pharmax/platform-core";

/** Caller supplied an invalid argument (empty action, NUL byte, etc.). */
export const AUDIT_VALIDATION = "AUDIT_VALIDATION" as const;

/** Chain verification found a row whose recomputed hash doesn't match. */
export const AUDIT_CHAIN_BROKEN = "AUDIT_CHAIN_BROKEN" as const;

/** Writer was called outside a transaction (no advisory-lock context). */
export const AUDIT_NOT_IN_TRANSACTION = "AUDIT_NOT_IN_TRANSACTION" as const;

/** Advisory lock acquisition failed (try-lock variant only). */
export const AUDIT_LOCK_UNAVAILABLE = "AUDIT_LOCK_UNAVAILABLE" as const;

export function auditValidationError(detail: {
  readonly field: string;
  readonly reason: string;
}): errors.ValidationError {
  return new errors.ValidationError({
    code: AUDIT_VALIDATION,
    message: `Invalid audit entry: ${detail.field}: ${detail.reason}`,
    issues: [{ path: [detail.field], message: detail.reason }],
  });
}

export function auditChainBrokenError(detail: {
  readonly organizationId: string;
  readonly seq: bigint;
  readonly reason: string;
  readonly expectedHashHex?: string;
  readonly actualHashHex?: string;
}): errors.InternalError {
  return new errors.InternalError({
    code: AUDIT_CHAIN_BROKEN,
    message: `Audit chain broken at seq ${detail.seq.toString()}: ${detail.reason}`,
    metadata: {
      organizationId: detail.organizationId,
      seq: detail.seq.toString(),
      reason: detail.reason,
      ...(detail.expectedHashHex === undefined ? {} : { expectedHashHex: detail.expectedHashHex }),
      ...(detail.actualHashHex === undefined ? {} : { actualHashHex: detail.actualHashHex }),
    },
  });
}

export function auditNotInTransactionError(): errors.InternalError {
  return new errors.InternalError({
    code: AUDIT_NOT_IN_TRANSACTION,
    message:
      "appendAuditChainEntryInTx must be called with a Prisma transaction client, not the root client. The per-tenant advisory lock requires a transaction scope.",
  });
}

export function auditLockUnavailableError(detail: {
  readonly organizationId: string;
}): errors.InternalError {
  return new errors.InternalError({
    code: AUDIT_LOCK_UNAVAILABLE,
    message: "Could not acquire the per-tenant audit-chain advisory lock.",
    metadata: { organizationId: detail.organizationId },
  });
}
