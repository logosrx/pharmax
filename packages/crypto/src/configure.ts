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

import { cryptoNotConfiguredError } from "./errors.js";
import type { KmsAdapter } from "./kms-adapter.js";

export interface CryptoConfiguration {
  readonly kms: KmsAdapter;
}

let configured: CryptoConfiguration | null = null;

/** Wire the process-wide KMS adapter. Call once at boot. */
export function configureCrypto(config: CryptoConfiguration): void {
  configured = Object.freeze({ ...config });
}

/** Returns the configured KMS adapter. Throws if `configureCrypto` was never called. */
export function getCryptoConfiguration(): CryptoConfiguration {
  if (configured === null) {
    throw cryptoNotConfiguredError();
  }
  return configured;
}

/** Test-only: reset the configuration. Production code MUST NOT call this. */
export function resetCryptoConfigurationForTests(): void {
  configured = null;
}
