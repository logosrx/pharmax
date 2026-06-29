// Process-wide crypto configuration.
//
// One process, one KMS adapter. Set at boot (apps/web, apps/worker,
// migrations, seed). Reading without configuration throws
// `InternalError(CRYPTO_NOT_CONFIGURED)` — silence here would mean a
// PHI write that somehow proceeded without ever invoking
// encryption, which is the worst possible failure mode (we'd notice
// only when the data was already on disk in plaintext).
//
// Same singleton pattern as @pharmax/rbac's `configureRbac`.

import { runtime } from "@pharmax/platform-core";

import { cryptoNotConfiguredError } from "./errors.js";
import type { KmsAdapter } from "./kms-adapter.js";

export interface CryptoConfiguration {
  readonly kms: KmsAdapter;
}

// globalThis-backed so boot (Next instrumentation bundle) and use
// (route bundles) share ONE configuration despite webpack giving each
// bundle its own copy of this module. See platform-core
// runtime/global-singleton.ts for the full rationale.
const box = runtime.globalSingletonBox<CryptoConfiguration>("pharmax:crypto:config");

/** Wire the process-wide KMS adapter. Call once at boot. */
export function configureCrypto(config: CryptoConfiguration): void {
  box.value = Object.freeze({ ...config });
}

/** Returns the configured KMS adapter. Throws if `configureCrypto` was never called. */
export function getCryptoConfiguration(): CryptoConfiguration {
  if (box.value === null) {
    throw cryptoNotConfiguredError();
  }
  return box.value;
}

/** Test-only: reset the configuration. Production code MUST NOT call this. */
export function resetCryptoConfigurationForTests(): void {
  box.value = null;
}
