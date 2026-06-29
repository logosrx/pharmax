// Process-wide DocumentStorage configuration.
//
// One process, one storage singleton. Set at boot (apps/web,
// apps/worker, scripts). Reading without configuration throws
// `InternalError(DOCUMENTS_NOT_CONFIGURED)` — silence would let a
// caller silently fall through to an unintended storage path, and
// for a PHI-bearing layer that is the worst possible failure mode.
//
// Mirrors `@pharmax/package-capture`'s `configurePackagePhotoStorage`
// and `@pharmax/notifications`'s `configureNotifications` — same
// pattern, same `reset…ForTests` helper, same `errors.InternalError`
// shape.

import { errors, runtime } from "@pharmax/platform-core";

import type { DocumentStorage } from "./ports/document-storage.js";

export const DOCUMENTS_NOT_CONFIGURED = "DOCUMENTS_NOT_CONFIGURED" as const;

export interface DocumentStorageConfiguration {
  readonly storage: DocumentStorage;
}

// globalThis-backed so boot (Next instrumentation bundle) and use
// (route bundles) share ONE configuration despite webpack giving each
// bundle its own copy of this module. See platform-core
// runtime/global-singleton.ts for the full rationale.
const box = runtime.globalSingletonBox<DocumentStorageConfiguration>("pharmax:documents:config");

/** Wire the process-wide document storage. Call once at boot. */
export function configureDocumentStorage(config: DocumentStorageConfiguration): void {
  box.value = Object.freeze({ storage: config.storage });
}

/** Returns the configured storage. Throws if `configureDocumentStorage`
 *  was never called. */
export function getDocumentStorage(): DocumentStorage {
  if (box.value === null) {
    throw new errors.InternalError({
      code: DOCUMENTS_NOT_CONFIGURED,
      message:
        "@pharmax/documents is not configured. Call configureDocumentStorage({ storage }) at process boot before any put/get/signUrl/delete.",
    });
  }
  return box.value.storage;
}

/** Test-only: reset configuration. Production code MUST NOT call this. */
export function resetDocumentStorageConfigurationForTests(): void {
  box.value = null;
}
