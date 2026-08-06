// @pharmax/crypto error codes.
//
// Crypto failures fall into two operational buckets:
//
//   - **Expected** (4xx-class): the caller passed inconsistent inputs.
//     The most important one is AAD_MISMATCH — the ciphertext's AAD
//     does not match the record we're trying to decrypt. This is the
//     SECURITY signal that someone moved a ciphertext between rows.
//     It is a SOC 2 audit event but NOT a page; we treat it as a 403.
//
//   - **Unexpected** (5xx-class): KMS unreachable, malformed envelope,
//     local state corruption. These page.
//
// PHI invariant: NOTHING in error metadata may contain the plaintext
// being encrypted/decrypted. Metadata is limited to record identifiers
// (which are ULIDs, not PHI), table/column names, and key identifiers.

import { errors } from "@pharmax/platform-core";

/** Crypto module was not configured at boot. */
export const CRYPTO_NOT_CONFIGURED = "CRYPTO_NOT_CONFIGURED" as const;

/** Ciphertext envelope is malformed or unrecognized version. */
export const ENVELOPE_MALFORMED = "ENVELOPE_MALFORMED" as const;

/** AAD bytes do not match the ciphertext — record binding violated. */
export const AAD_MISMATCH = "AAD_MISMATCH" as const;

/** Underlying GCM authentication tag did not verify. */
export const DECRYPT_FAILED = "DECRYPT_FAILED" as const;

/** KMS could not find / unwrap the requested key. */
export const KMS_KEY_NOT_FOUND = "KMS_KEY_NOT_FOUND" as const;

/**
 * The IAM principal is not authorized for the KMS operation. Split
 * out from `KMS_KEY_NOT_FOUND` because the remedy is disjoint: an
 * `AccessDeniedException` is fixed in the task role or the CMK key
 * policy, whereas a `NotFoundException` is fixed in
 * `AWS_KMS_DATA_KEY_ID` / `AWS_KMS_SEARCH_KEY_ID` or `AWS_REGION`.
 * Both page as 500s; the code is what routes the responder.
 */
export const KMS_ACCESS_DENIED = "KMS_ACCESS_DENIED" as const;

/** Caller supplied an invalid argument (e.g. empty tenantId). */
export const CRYPTO_VALIDATION = "CRYPTO_VALIDATION" as const;

export function cryptoNotConfiguredError(): errors.InternalError {
  return new errors.InternalError({
    code: CRYPTO_NOT_CONFIGURED,
    message:
      "@pharmax/crypto was not configured. Call configureCrypto({ kms }) at process boot before any encrypt/decrypt call.",
  });
}

export function envelopeMalformedError(detail: {
  readonly reason: string;
}): errors.ValidationError {
  return new errors.ValidationError({
    code: ENVELOPE_MALFORMED,
    message: `Ciphertext envelope is malformed: ${detail.reason}`,
    issues: [{ path: ["envelope"], message: detail.reason }],
  });
}

export function aadMismatchError(detail: {
  readonly tenantId: string;
  readonly table: string;
  readonly column: string;
  readonly recordId: string;
}): errors.AuthorizationError {
  // 403 because the most plausible cause is someone moving a ciphertext
  // between rows. The audit feed flags this as a security event.
  return new errors.AuthorizationError({
    code: AAD_MISMATCH,
    message: "Ciphertext AAD does not match the expected record binding.",
    metadata: {
      tenantId: detail.tenantId,
      table: detail.table,
      column: detail.column,
      recordId: detail.recordId,
    },
  });
}

export function decryptFailedError(detail: {
  readonly reason: string;
  readonly tenantId: string;
  readonly table: string;
  readonly column: string;
  readonly recordId: string;
  /**
   * The underlying provider or GCM failure. Optional so existing
   * callers keep compiling; thread it wherever one exists, because
   * a decrypt failure with no stack is unactionable at 3am.
   */
  readonly cause?: unknown;
}): errors.InternalError {
  return new errors.InternalError({
    code: DECRYPT_FAILED,
    message: `Decryption failed: ${detail.reason}`,
    metadata: {
      tenantId: detail.tenantId,
      table: detail.table,
      column: detail.column,
      recordId: detail.recordId,
    },
    ...(detail.cause === undefined ? {} : { cause: detail.cause }),
  });
}

/**
 * Shared detail shape for the two KMS key-resolution failures.
 *
 * `kid` is a key IDENTIFIER and nothing else — an envelope kid
 * (`aws:kek:<label>:<tenant>:v1`) on the unwrap path, or the
 * configured KMS key id / ARN / alias on the boot path. It is read
 * programmatically and lands in log fields and alarm dimensions, so
 * prose in this slot corrupts every downstream consumer.
 *
 * The human explanation belongs in `reason` (which the factory folds
 * into `message`). The underlying provider error belongs in `cause`,
 * NOT in metadata: `PharmaxError.toJSON` deliberately drops `cause`,
 * and an AWS error message can echo request detail we do not want in
 * an indexed field. `awsErrorName` is the modeled exception shape
 * name only (`AccessDeniedException`, `NotFoundException`), which is
 * a bounded, non-sensitive value and therefore safe to index.
 */
interface KmsKeyErrorDetail {
  readonly tenantId: string;
  readonly kid: string;
  readonly reason?: string;
  readonly awsErrorName?: string;
  readonly cause?: unknown;
}

function kmsKeyError(
  code: string,
  summary: string,
  detail: KmsKeyErrorDetail
): errors.InternalError {
  return new errors.InternalError({
    code,
    message: detail.reason === undefined ? `${summary}.` : `${summary}: ${detail.reason}`,
    metadata: {
      tenantId: detail.tenantId,
      kid: detail.kid,
      ...(detail.awsErrorName === undefined ? {} : { awsErrorName: detail.awsErrorName }),
    },
    ...(detail.cause === undefined ? {} : { cause: detail.cause }),
  });
}

export function kmsKeyNotFoundError(detail: KmsKeyErrorDetail): errors.InternalError {
  return kmsKeyError(
    KMS_KEY_NOT_FOUND,
    `KMS could not resolve key "${detail.kid}" for tenant`,
    detail
  );
}

/**
 * KMS refused the operation on authorization grounds. The key may
 * well exist and be perfectly healthy — do not send the responder
 * looking for a missing key.
 */
export function kmsAccessDeniedError(detail: KmsKeyErrorDetail): errors.InternalError {
  return kmsKeyError(
    KMS_ACCESS_DENIED,
    `KMS denied access to key "${detail.kid}" for tenant`,
    detail
  );
}

export function cryptoValidationError(detail: {
  readonly field: string;
  readonly reason: string;
}): errors.ValidationError {
  return new errors.ValidationError({
    code: CRYPTO_VALIDATION,
    message: `Invalid crypto input: ${detail.field}: ${detail.reason}`,
    issues: [{ path: [detail.field], message: detail.reason }],
  });
}
