// Public surface of @pharmax/package-capture.
//
// What lives here:
//   - `CapturePackagePhoto` — write the dock-capture record.
//   - `ResolvePackagePhotoMatch` — operator triage of an
//     unmatched capture (links it to a specific order, back-fills
//     clinic + tracking metadata).
//   - The `PackagePhotoStorage` port + the in-memory test adapter.
//   - The boot-time `configurePackagePhotoStorage` singleton.
//   - The dictionary of typed error codes the commands can throw.
//
// What does NOT live here:
//   - The HTTP routes. Those belong in `apps/web/app/api/ops/...`.
//   - `ArchivePackagePhoto` (future — operator marks a capture
//     as orphaned with no possible match).
//
// The S3 production adapter (`S3PackagePhotoStorage`) and its
// narrow `S3UploadClient` port live here too, but require boot-
// time KMS/bucket provisioning to be useful — the in-memory
// adapter remains the default for tests + dev.

export {
  CapturePackagePhoto,
  type CapturePackagePhotoInput,
  type CapturePackagePhotoOutput,
  PACKAGE_PHOTO_UPLOAD_TOKEN_UNKNOWN,
  PACKAGE_PHOTO_UPLOAD_TOKEN_TENANT_MISMATCH,
  PACKAGE_PHOTO_DUPLICATE_BYTES,
} from "./commands/capture-package-photo.js";

export {
  ResolvePackagePhotoMatch,
  type ResolvePackagePhotoMatchInput,
  type ResolvePackagePhotoMatchOutput,
  PACKAGE_PHOTO_NOT_FOUND,
  PACKAGE_PHOTO_TARGET_ORDER_NOT_FOUND,
  PACKAGE_PHOTO_ALREADY_MATCHED,
} from "./commands/resolve-package-photo-match.js";

export type {
  PackagePhotoStorage,
  PackagePhotoUploadInput,
  PackagePhotoUploadResult,
  ResolvedPackagePhotoUpload,
  PackagePhotoReadInput,
  PackagePhotoObject,
} from "./storage/package-photo-storage.js";

export {
  InMemoryPackagePhotoStorage,
  type InMemoryPackagePhotoStorageOptions,
} from "./storage/in-memory-package-photo-storage.js";

export {
  S3PackagePhotoStorage,
  PACKAGE_PHOTO_UPLOAD_TTL_MS,
  S3_PACKAGE_PHOTO_STORAGE_NO_TENANCY,
  S3_PACKAGE_PHOTO_STORAGE_TENANCY_MISMATCH,
  type S3PackagePhotoStorageOptions,
  type S3UploadClient,
  type S3PutObjectInput,
  type S3PutObjectOutput,
  type S3GetObjectInput,
  type S3GetObjectOutput,
} from "./storage/s3-package-photo-storage.js";

export {
  configurePackagePhotoStorage,
  getPackagePhotoStorage,
  resetPackagePhotoStorageConfigurationForTests,
  type PackagePhotoStorageConfiguration,
} from "./storage/configure.js";

import * as capturePackagePhotoModule from "./commands/capture-package-photo.js";
import * as resolvePackagePhotoMatchModule from "./commands/resolve-package-photo-match.js";

/** Convenience namespace for the bus dispatcher. */
export const packageCapture = {
  commands: {
    CapturePackagePhoto: capturePackagePhotoModule.CapturePackagePhoto,
    ResolvePackagePhotoMatch: resolvePackagePhotoMatchModule.ResolvePackagePhotoMatch,
  },
} as const;
