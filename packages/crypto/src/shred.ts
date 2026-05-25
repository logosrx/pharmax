// Crypto-shred — render an encrypted field permanently unreadable.
//
// Per-record shred is a *storage-layer* operation: overwrite the
// envelope column with NULL. The wrapped DEK lived only inside the
// envelope, so deleting the column kills the only path to the
// plaintext. No KMS round-trip needed.
//
// We expose this as a function rather than telling callers "just set
// it to NULL" for three reasons:
//
//   1. **Intent at call site.** `await shredEnvelope(...)` makes the
//      reviewer see a crypto-shred happening, not a routine UPDATE.
//   2. **Audit hook.** Callers wrap this in their command handler;
//      the handler writes a `CRYPTO_SHRED` row to `audit_log` with
//      the reason code (`right-to-be-forgotten`, `tenant-offboard`,
//      etc.). This module doesn't write audit directly — that's the
//      command bus's job — but the signature accepts a reason so the
//      bus has a structured value to log.
//   3. **Type-safety.** The function returns a sentinel that is
//      explicit about what gets written, so callers can't
//      accidentally pass a stale envelope object instead of NULL.
//
// Tenant-wide crypto-shred (offboarding) is a separate flow: rotate
// the per-tenant KEK and DROP the historical version from the KMS
// adapter. Existing wrapped DEKs become unwrappable on the next
// read. That flow is implemented at the KMS adapter level — see
// `LocalKmsAdapter.rotateKek` and the future `AwsKmsAdapter`.

import { cryptoValidationError } from "./errors.js";

/** Stable reason vocabulary for the audit log. Extend explicitly. */
export const CRYPTO_SHRED_REASONS = Object.freeze({
  RIGHT_TO_BE_FORGOTTEN: "right-to-be-forgotten",
  TENANT_OFFBOARD: "tenant-offboard",
  DATA_RETENTION_EXPIRY: "data-retention-expiry",
  PATIENT_DECEASED_RECORD_CLOSE: "patient-deceased-record-close",
} as const);

export type CryptoShredReason = (typeof CRYPTO_SHRED_REASONS)[keyof typeof CRYPTO_SHRED_REASONS];

export interface CryptoShredPlan {
  /** Always `null` — the value to write to the envelope column. */
  readonly nextValue: null;
  /** Echoed for the audit log. */
  readonly tenantId: string;
  readonly table: string;
  readonly column: string;
  readonly recordId: string;
  readonly reason: CryptoShredReason;
}

/**
 * Produces a `CryptoShredPlan` whose `nextValue` is `null`. Callers
 * apply the plan inside a command handler transaction: write the
 * NULL, write the audit entry, write the outbox event, commit.
 *
 * Pure: no KMS calls, no I/O. The function exists so the call site
 * documents intent.
 */
export function planCryptoShred(input: {
  readonly tenantId: string;
  readonly table: string;
  readonly column: string;
  readonly recordId: string;
  readonly reason: CryptoShredReason;
}): CryptoShredPlan {
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.length === 0) {
      throw cryptoValidationError({ field, reason: "must be a non-empty string" });
    }
  }
  if (!Object.values(CRYPTO_SHRED_REASONS).includes(input.reason)) {
    throw cryptoValidationError({
      field: "reason",
      reason: "must be a registered CRYPTO_SHRED_REASONS code",
    });
  }
  return {
    nextValue: null,
    tenantId: input.tenantId,
    table: input.table,
    column: input.column,
    recordId: input.recordId,
    reason: input.reason,
  };
}
