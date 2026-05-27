// parsePackagePhotoUpload — request-side validation for the
// `POST /api/ops/shipping/package-photos/uploads` multipart receiver.
//
// Why a dedicated helper:
//
//   - The upload route is the ONLY web-tier surface that accepts
//     binary bytes from an authenticated operator. The validation
//     rules (allowed content types, max size) are policy: changing
//     them mid-feature should be a one-file diff, not grep across
//     the route handlers we'll add next.
//
//   - Pulling validation out of the route handler makes it testable
//     without mounting a Next.js Request — the helper takes a
//     `FormData` directly and returns a discriminated result.
//
//   - It centralizes the failure shape: the route only has to map
//     `result.kind === "error"` to a 4xx JSON response.
//
// Policy:
//
//   - Content-type allowlist: `image/jpeg` | `image/png` | `image/webp`.
//     PNG and WebP are accepted because mobile camera SDKs
//     (notably some Chromium-based PWAs) default to PNG, and WebP
//     halves the payload size on supporting browsers. Other image
//     formats (TIFF, HEIC, GIF, SVG) are refused at the boundary —
//     the storage adapter would happily store them, but downstream
//     image-processing assumes a finite codec set.
//
//   - Hard size cap: 25 MiB. A pharmacy dock photo is typically
//     1–4 MiB. The cap is generous for a near-future "burst capture"
//     feature (multi-angle photos compressed into a single payload)
//     while staying well under the Next.js / Edge function body
//     limits and the AWS API Gateway 10 MiB ceiling we'd hit when
//     the S3 adapter goes live (S3 direct-PUT pre-signed URLs lift
//     the ceiling; this cap stays conservative for the streaming
//     fallback).
//
//   - Field name: `file`. The route's documented contract; surfaced
//     here so the helper's test pins it.
//
// PHI invariant: this helper never logs the bytes, never logs the
// filename (the operator's filename may contain a patient identifier
// by accident — e.g. "smith_dosage.jpg"), and never echoes the
// content into the error message.

const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** 25 MiB — see file-level policy comment. */
export const MAX_PACKAGE_PHOTO_BYTES = 25 * 1024 * 1024;

export const PACKAGE_PHOTO_FIELD_NAME = "file";

export const PACKAGE_PHOTO_UPLOAD_FILE_MISSING = "PACKAGE_PHOTO_UPLOAD_FILE_MISSING";
export const PACKAGE_PHOTO_UPLOAD_CONTENT_TYPE_REJECTED =
  "PACKAGE_PHOTO_UPLOAD_CONTENT_TYPE_REJECTED";
export const PACKAGE_PHOTO_UPLOAD_TOO_LARGE = "PACKAGE_PHOTO_UPLOAD_TOO_LARGE";
export const PACKAGE_PHOTO_UPLOAD_EMPTY = "PACKAGE_PHOTO_UPLOAD_EMPTY";

export type PackagePhotoUploadErrorCode =
  | typeof PACKAGE_PHOTO_UPLOAD_FILE_MISSING
  | typeof PACKAGE_PHOTO_UPLOAD_CONTENT_TYPE_REJECTED
  | typeof PACKAGE_PHOTO_UPLOAD_TOO_LARGE
  | typeof PACKAGE_PHOTO_UPLOAD_EMPTY;

export interface ParsedPackagePhotoUpload {
  readonly kind: "ok";
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface ParsedPackagePhotoUploadError {
  readonly kind: "error";
  readonly code: PackagePhotoUploadErrorCode;
  readonly message: string;
}

export type ParsePackagePhotoUploadResult =
  | ParsedPackagePhotoUpload
  | ParsedPackagePhotoUploadError;

/**
 * Inspect a multipart `FormData` and produce either a validated
 * `{ contentType, bytes }` pair or a typed error. The caller (the
 * route handler) is responsible for translating the error code into
 * an HTTP status — this helper has no opinion on transport.
 */
export async function parsePackagePhotoUpload(
  form: FormData
): Promise<ParsePackagePhotoUploadResult> {
  const raw = form.get(PACKAGE_PHOTO_FIELD_NAME);

  // `form.get` returns `string | File | null`. We require a File
  // (multipart upload semantics); a string slot means the client
  // posted a text field instead of a file.
  if (!(raw instanceof File)) {
    return {
      kind: "error",
      code: PACKAGE_PHOTO_UPLOAD_FILE_MISSING,
      message: `Missing file in field "${PACKAGE_PHOTO_FIELD_NAME}". Send a multipart/form-data body with the photo bytes in this field.`,
    };
  }

  const contentType = raw.type;
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return {
      kind: "error",
      code: PACKAGE_PHOTO_UPLOAD_CONTENT_TYPE_REJECTED,
      message: `Unsupported content type "${contentType}". Allowed: ${Array.from(
        ALLOWED_CONTENT_TYPES
      )
        .sort()
        .join(", ")}.`,
    };
  }

  // Reject before reading the bytes when the size header alone
  // already exceeds the cap. Saves us a full buffer copy on a
  // hostile client. We still re-check after `arrayBuffer()` — the
  // header is advisory, the byteLength is authoritative.
  if (raw.size > MAX_PACKAGE_PHOTO_BYTES) {
    return {
      kind: "error",
      code: PACKAGE_PHOTO_UPLOAD_TOO_LARGE,
      message: `File is ${raw.size} bytes, exceeds the ${MAX_PACKAGE_PHOTO_BYTES}-byte cap.`,
    };
  }

  const buffer = await raw.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (bytes.byteLength === 0) {
    return {
      kind: "error",
      code: PACKAGE_PHOTO_UPLOAD_EMPTY,
      message: "File is empty (0 bytes). Did the camera capture fail?",
    };
  }
  if (bytes.byteLength > MAX_PACKAGE_PHOTO_BYTES) {
    return {
      kind: "error",
      code: PACKAGE_PHOTO_UPLOAD_TOO_LARGE,
      message: `File is ${bytes.byteLength} bytes, exceeds the ${MAX_PACKAGE_PHOTO_BYTES}-byte cap.`,
    };
  }

  return { kind: "ok", contentType, bytes };
}
