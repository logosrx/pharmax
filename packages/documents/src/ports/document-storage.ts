// DocumentStorage — the cross-cutting port for storing arbitrary
// classified bytes (prescription images, lab results, signed
// documents, generated invoice PDFs, operational reports).
//
// One port, one adapter per environment:
//
//   - `InMemoryDocumentStorage` for tests + ephemeral dev. No
//     bucket, no signed URLs against an external service.
//   - (future) `S3DocumentStorage` — production adapter that uses
//     per-classification KMS keys, per-tenant prefix paths, and
//     presigned GET / PUT URLs with TTLs bounded by
//     `maxSignedUrlTtlSeconds()`.
//
// **PHI handling is structural.** When `classification === "PHI"`,
// the caller MUST pass an `aadBinding`; the port refuses the put
// otherwise. The adapter then runs the bytes through
// `@pharmax/crypto::encryptField` with that binding before
// persistence. `get` requires the SAME binding back — a caller
// who tries to retrieve a PHI document with the wrong binding
// receives `AuthorizationError(AAD_MISMATCH)` from the crypto
// layer, just like any other field-level encrypted column.
//
// **Generalization note.** The shape here is deliberately a strict
// superset of `@pharmax/package-capture::PackagePhotoStorage`. A
// follow-up slice can refactor that port to be a thin specialization
// of this one (its `beginUpload` becomes a wrapper around `put`
// with `classification: "INTERNAL"` — package photos are NOT PHI
// per the existing threat model, see `package-photo-storage.ts`).
// Today they coexist; the photo-storage port stays put until the
// refactor lands so existing call sites don't churn.

import type { RecordBinding } from "@pharmax/crypto";

import type { DocumentClassification } from "../classification.js";

/**
 * AAD binding for PHI documents. Mirrors `@pharmax/crypto`'s
 * `RecordBinding` shape exactly so a caller who already has a
 * record binding for the row that anchors the document can pass
 * it through untouched.
 *
 * For a prescription image, a sensible binding is:
 *
 *     { tenantId: organizationId,
 *       table: "prescription",
 *       column: "scan_image",
 *       recordId: prescriptionId }
 *
 * The adapter encrypts the bytes under this binding; a future
 * attempt to GET the document with `{ recordId: differentId }`
 * fails with AAD_MISMATCH.
 */
export type AadBinding = RecordBinding;

/** Shape passed to `put`. */
export interface DocumentPutInput {
  /** Tenant scope. The adapter MUST scope storage by tenant; a
   *  cross-tenant GET on the same document id is a critical bug. */
  readonly tenantId: string;
  readonly classification: DocumentClassification;
  /** MIME type. The adapter stores it and echoes it back on `get`
   *  / `signUrl` so the consuming code doesn't have to remember. */
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /**
   * REQUIRED when `classification === "PHI"`, forbidden when
   * `classification === "PUBLIC"`, optional for the middle two.
   * The adapter passes it to `encryptField` for PHI; for
   * non-PHI it is recorded as metadata only (some auditors want
   * to know "this CONFIDENTIAL invoice PDF was bound to invoice
   * id X" without paying the per-field crypto cost).
   */
  readonly aadBinding?: AadBinding;
  /** Arbitrary string-valued metadata. The adapter MUST NOT route
   *  routing decisions on these values; they exist for caller-side
   *  bookkeeping (uploadedByUserId, sourceCommandId, etc.). PHI
   *  MUST NOT appear here — the metadata is logged like any other
   *  structured field. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Shape returned by `put`. */
export interface DocumentPutResult {
  /** Opaque adapter-side identifier. Callers persist this on the
   *  domain row (e.g. `prescription.image_document_id`). */
  readonly documentId: string;
  /** sha256 over the RAW (plaintext) bytes. Useful for dedup,
   *  integrity checks, and "did the upload arrive intact" probes.
   *  The adapter holds the encrypted form on disk; the sha256
   *  is recorded once at put time and surfaces forever after. */
  readonly sha256: string;
  /** Bucket name (logical for in-memory, real for S3). */
  readonly bucket: string;
  /** Object key inside the bucket. The shape is adapter-defined;
   *  callers should not depend on it. */
  readonly key: string;
  /** Stored byte size (the encrypted-on-disk size for PHI; the raw
   *  size for non-PHI). */
  readonly fileSize: number;
}

/** Shape returned by `get`. */
export interface DocumentGetResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly classification: DocumentClassification;
}

/** Options accepted by `get`. */
export interface DocumentGetOptions {
  /** Required when the document was stored with `classification === "PHI"`.
   *  Adapters surface a missing-binding read as an authorization
   *  error rather than silently returning ciphertext. */
  readonly aadBinding?: AadBinding;
}

/** Shape returned by `signUrl`. */
export interface DocumentSignUrlResult {
  readonly url: string;
  readonly expiresAt: Date;
}

/** Options for `signUrl`. */
export interface DocumentSignUrlOptions {
  /** Adapter-enforced ceiling per classification — see
   *  `maxSignedUrlTtlSeconds()` in `classification.ts`. */
  readonly ttlSeconds: number;
  /** When provided, the adapter sets a `Content-Disposition:
   *  attachment; filename="..."` header on the signed response. */
  readonly downloadFilename?: string;
}

/** Reasons a document can be deleted. Closed enum so audit reports
 *  can group cleanly. */
export const DOCUMENT_DELETE_REASONS = [
  "USER_REQUESTED",
  "RETENTION_POLICY_EXPIRY",
  "REPLACED_BY_NEW_VERSION",
  "CRYPTO_SHRED",
  "ADMIN_PURGE",
] as const;

export type DocumentDeleteReason = (typeof DOCUMENT_DELETE_REASONS)[number];

export interface DocumentDeleteOptions {
  readonly reason: DocumentDeleteReason;
}

/**
 * The port. Implementations live OUTSIDE this package (production
 * adapters in `apps/worker/src/storage/...`; an in-memory adapter
 * ships here for tests).
 */
export interface DocumentStorage {
  put(input: DocumentPutInput): Promise<DocumentPutResult>;

  /** Get the document bytes back. PHI requires the same `aadBinding`
   *  used at put time; the adapter surfaces a mismatch as the
   *  crypto layer's `AAD_MISMATCH` (a 403). */
  get(documentId: string, options?: DocumentGetOptions): Promise<DocumentGetResult>;

  /** Mint a short-lived URL the client can fetch the document at.
   *  TTL is bounded by `maxSignedUrlTtlSeconds(classification)`. */
  signUrl(documentId: string, options: DocumentSignUrlOptions): Promise<DocumentSignUrlResult>;

  /** Permanently remove the document. The adapter records the
   *  reason for audit. For PHI documents stored encrypted, the
   *  adapter MAY implement this as crypto-shred (overwrite the
   *  wrapped DEK) rather than a physical bytes delete. */
  delete(documentId: string, options: DocumentDeleteOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error codes the port + every adapter MAY throw.
// ---------------------------------------------------------------------------

export const DOCUMENT_NOT_FOUND = "DOCUMENT_NOT_FOUND" as const;
export const DOCUMENT_AAD_BINDING_REQUIRED = "DOCUMENT_AAD_BINDING_REQUIRED" as const;
export const DOCUMENT_AAD_BINDING_UNEXPECTED = "DOCUMENT_AAD_BINDING_UNEXPECTED" as const;
export const DOCUMENT_TENANT_MISMATCH = "DOCUMENT_TENANT_MISMATCH" as const;
export const DOCUMENT_TTL_EXCEEDED = "DOCUMENT_TTL_EXCEEDED" as const;
export const DOCUMENT_VALIDATION = "DOCUMENT_VALIDATION" as const;
export const DOCUMENT_TRANSPORT_ERROR = "DOCUMENT_TRANSPORT_ERROR" as const;
