// Package-photo storage port.
//
// The shipping rep's client uploads photo bytes to the storage
// adapter BEFORE calling the `CapturePackagePhoto` command. The
// adapter:
//
//   1. Stores the bytes (S3 in prod, in-memory in tests).
//   2. Computes sha256 over the raw bytes.
//   3. Returns an opaque `uploadToken` (along with sha256 / key /
//      bucket / fileSize) that the client carries forward to the
//      command call.
//
// The command then calls `resolveUploadToken(token)` inside its
// transaction to recover the same metadata, and persists it on the
// `package_photo` row. The bytes never traverse the command bus's
// serialization path — the bus's `command_log.requestPayload` only
// ever sees the token (which is opaque + short-lived).
//
// Why a token instead of passing { bucket, key, sha256 } directly:
//   - The token is the storage adapter's INTEGRITY claim. The
//     command verifies the token resolves to a real upload before
//     persisting. A caller cannot fabricate a `(bucket, key,
//     sha256)` tuple that the storage layer never accepted —
//     resolveUploadToken is the choke point.
//   - In production with S3 + presigned PUT, the token can also
//     carry the signed-URL claim (issued by us, redeemed by the
//     client) so the client never holds long-term S3 credentials.
//
// PHI rule: photo bytes themselves are NOT classified PHI in
// Pharmax's threat model (a sealed package on a dock + an
// external order number is not a patient identifier; the storage
// adapter is also REQUIRED to be SSE-KMS at rest). The `notes`
// field on `CapturePackagePhoto` IS PHI-possible and lives on a
// separate envelope-encrypted column — never in the storage layer.

/**
 * Shape passed to `beginUpload`. The caller (typically a Next.js
 * route handler or a test) hands the storage adapter the raw
 * bytes, the operator's tenant id, and the content type.
 */
export interface PackagePhotoUploadInput {
  readonly organizationId: string;
  readonly contentType: string;
  /** Raw photo bytes. Adapter computes sha256 over these. */
  readonly bytes: Uint8Array;
}

/** Metadata returned from a successful upload. */
export interface PackagePhotoUploadResult {
  /** Opaque, short-lived token. The command resolves it back to the
   *  upload's metadata; clients never inspect it. */
  readonly uploadToken: string;
  readonly bucket: string;
  readonly key: string;
  readonly sha256: string;
  readonly fileSize: number;
  readonly contentType: string;
}

/** Metadata returned from `resolveUploadToken`. */
export interface ResolvedPackagePhotoUpload {
  readonly bucket: string;
  readonly key: string;
  readonly sha256: string;
  readonly fileSize: number;
  readonly contentType: string;
  readonly organizationId: string;
}

/**
 * Pointer passed to `readObject` to fetch stored bytes back. The
 * caller (the authenticated image-stream route) sources these from
 * the RLS-scoped `package_photo` row, so the `(organizationId,
 * bucket, key)` tuple is already tenant-validated; the adapter
 * re-checks the org against the key as defense in depth.
 */
export interface PackagePhotoReadInput {
  readonly organizationId: string;
  readonly bucket: string;
  readonly key: string;
}

/** Bytes + content type returned from `readObject`. */
export interface PackagePhotoObject {
  readonly bytes: Uint8Array;
  /**
   * The storage layer's recorded content type. The image route
   * still prefers the `package_photo.contentType` column (which was
   * validated against the upload allowlist) for the response
   * header; this is informational / cross-check only.
   */
  readonly contentType: string;
}

/**
 * Storage adapter contract. One implementation per environment:
 *
 *   - `InMemoryPackagePhotoStorage` for tests + ephemeral dev. No
 *     network, no signed URLs, no expiry.
 *   - (future) `S3PackagePhotoStorage` wraps the AWS SDK with
 *     presigned PUT for upload + presigned GET for read; the
 *     bucket is SSE-KMS at rest with a per-org KMS key.
 *
 * The `CapturePackagePhoto` command depends only on this
 * interface; swapping adapters is one boot-time line.
 */
export interface PackagePhotoStorage {
  /** Upload + return a token the command can resolve. */
  beginUpload(input: PackagePhotoUploadInput): Promise<PackagePhotoUploadResult>;
  /** Resolve a token; returns null when unknown or expired. */
  resolveUploadToken(token: string): Promise<ResolvedPackagePhotoUpload | null>;
  /**
   * Read stored bytes back by their `(bucket, key)` pointer. Returns
   * `null` when the object does not exist — e.g. the in-memory
   * adapter after a process restart, or an S3 object swept by the
   * janitor. The route maps `null` to a 404.
   *
   * The adapter MUST refuse to serve bytes whose `key` is not
   * prefixed for `organizationId` (`org/{organizationId}/...`),
   * returning `null`. This is defense in depth above the route's
   * RLS-scoped `package_photo` lookup: a corrupt row pointing at a
   * foreign key must never leak cross-tenant bytes.
   */
  readObject(input: PackagePhotoReadInput): Promise<PackagePhotoObject | null>;
}
