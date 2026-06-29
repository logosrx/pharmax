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

import { errors, runtime } from "@pharmax/platform-core";

import type { PackagePhotoStorage } from "./package-photo-storage.js";

export interface PackagePhotoStorageConfiguration {
  readonly storage: PackagePhotoStorage;
}

// globalThis-backed so boot (Next instrumentation bundle) and use
// (route bundles) share ONE configuration despite webpack giving each
// bundle its own copy of this module. See platform-core
// runtime/global-singleton.ts for the full rationale.
const box = runtime.globalSingletonBox<PackagePhotoStorageConfiguration>(
  "pharmax:package-capture:storage"
);

export function configurePackagePhotoStorage(config: PackagePhotoStorageConfiguration): void {
  box.value = Object.freeze({ storage: config.storage });
}

export function getPackagePhotoStorage(): PackagePhotoStorage {
  if (box.value === null) {
    throw new errors.InternalError({
      code: "PACKAGE_PHOTO_STORAGE_NOT_CONFIGURED",
      message:
        "@pharmax/package-capture storage is not configured. Call configurePackagePhotoStorage({ storage }) at boot before dispatching CapturePackagePhoto.",
    });
  }
  return box.value.storage;
}

export function resetPackagePhotoStorageConfigurationForTests(): void {
  box.value = null;
}
