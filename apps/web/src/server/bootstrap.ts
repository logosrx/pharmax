// Process-wide singleton boot.
//
// Wires every "configure once, use everywhere" subsystem the web app
// depends on. Imported from `apps/web/instrumentation.ts` (Next.js's
// official one-shot boot hook) so it runs exactly once per Node
// process — even though the Next dev server may import server modules
// many times during the request lifecycle, instrumentation runs once.
//
// Anything that needs a process-wide singleton MUST be wired here:
//   - @pharmax/crypto: KMS adapter (PHI encryption).
//   - @pharmax/rbac: permission loader (when wired in Phase 1.5).
//   - @pharmax/command-bus: Prisma client + clock + logger (when
//     wired with the first route-driven command in Phase 2).
//
// Why a single file:
//   - The order of `configureX` calls is part of the contract
//     (crypto must be ready BEFORE the first PHI read/write).
//   - A reviewer can audit boot in one place — "what runs at process
//     start?" should not require grep across the repo.
//   - If a subsystem fails to configure, the process MUST refuse to
//     serve requests. Centralizing the failure surface here means a
//     misconfig produces ONE clear stack trace at boot, not a stream
//     of cryptic errors per request.
//
// PHI invariant: nothing in this file may read or log PHI. The KMS
// seed itself is high-entropy random and not PHI, but treat it as a
// secret — env.ts validates length and never echoes the value.

import "server-only";

import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";

import { env } from "./env.js";
import { logger } from "./logger.js";
import { initSentry } from "./observability/sentry-init.js";

let booted = false;

/**
 * Idempotent boot. Safe to call multiple times (no-op after the first
 * call) but designed to be called once from instrumentation.ts.
 *
 * Order matters:
 *   1. Sentry FIRST — so any exception thrown by later boot steps
 *      (e.g. KMS misconfig) reaches Sentry instead of dying silently.
 *   2. Crypto / KMS — required before any PHI read or write.
 *   3. (Future) RBAC + command-bus — order documented at their sites.
 */
export function bootstrap(): void {
  if (booted) return;
  booted = true;

  // 1. Sentry. No-ops when SENTRY_DSN is unset; emits a warning when
  // we're in production without a DSN so prod misconfig is loud.
  const sentryReady = initSentry({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    ...(env.SENTRY_RELEASE !== undefined ? { release: env.SENTRY_RELEASE } : {}),
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    profilesSampleRate: env.SENTRY_PROFILES_SAMPLE_RATE,
  });

  if (env.NODE_ENV === "production" && !sentryReady) {
    logger.warn("apps/web booted in production without Sentry", {
      reason: "SENTRY_DSN not configured",
    });
  }

  // 2. @pharmax/crypto — wire the LocalKmsAdapter for dev/test. In
  // production this branch flips to `new AwsKmsAdapter({ ... })`
  // and the `PHARMAX_LOCAL_KMS_SEED` env var is removed.
  if (env.NODE_ENV === "production") {
    // Hard fail: shipping LocalKmsAdapter to production would put
    // PHI under a process-derived key with no HSM custody. This
    // branch exists to surface the misconfiguration LOUDLY at boot
    // rather than silently encrypting prod PHI under dev keys.
    throw new Error(
      "Refusing to boot apps/web in production with LocalKmsAdapter. Implement and wire AwsKmsAdapter before promoting."
    );
  }
  configureCrypto({
    kms: new LocalKmsAdapter({ seed: env.PHARMAX_LOCAL_KMS_SEED }),
  });

  logger.info("apps/web bootstrap complete", {
    nodeEnv: env.NODE_ENV,
    cryptoAdapter: "LocalKmsAdapter",
    sentryReady,
  });
}
