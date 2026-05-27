// Process-wide PackagePhotoStorage configuration.
//
// The `CapturePackagePhoto` command reaches for the configured
// adapter via `getPackagePhotoStorage()`. Wire ONE adapter per
// process at boot (apps/web, apps/worker, scripts):
//
//   - production: `new S3PackagePhotoStorage({...})` (Phase 5b).
//   - dev / tests: `new InMemoryPackagePhotoStorage()`.
//
// Calling `configurePackagePhotoStorage` twice replaces the
// previous adapter — useful in tests via
// `resetPackagePhotoStorageConfigurationForTests`.
//
// Reading an unconfigured registry throws
// `InternalError(PACKAGE_PHOTO_STORAGE_NOT_CONFIGURED)`. Silence
// here would let the command silently fall through to a different
// path, which is the worst possible outcome for a feature whose
// only output IS the photo bytes — a missed configuration must
// fail loudly at the first dispatch.

import { errors } from "@pharmax/platform-core";

import type { PackagePhotoStorage } from "./package-photo-storage.js";

export interface PackagePhotoStorageConfiguration {
  readonly storage: PackagePhotoStorage;
}

let configured: PackagePhotoStorageConfiguration | null = null;

export function configurePackagePhotoStorage(config: PackagePhotoStorageConfiguration): void {
  configured = Object.freeze({ storage: config.storage });
}

export function getPackagePhotoStorage(): PackagePhotoStorage {
  if (configured === null) {
    throw new errors.InternalError({
      code: "PACKAGE_PHOTO_STORAGE_NOT_CONFIGURED",
      message:
        "@pharmax/package-capture storage is not configured. Call configurePackagePhotoStorage({ storage }) at boot before dispatching CapturePackagePhoto.",
    });
  }
  return configured.storage;
}

export function resetPackagePhotoStorageConfigurationForTests(): void {
  configured = null;
}
