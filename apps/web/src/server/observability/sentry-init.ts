// Sentry server-side initialization for apps/web.
//
// Called exactly once from `apps/web/instrumentation.ts` via the
// shared `bootstrap()` function — Sentry MUST be initialized before
// any other code that might throw, otherwise the first errors of the
// process lifecycle are missed.
//
// Why a dedicated module (vs. inline `Sentry.init()` in bootstrap.ts):
//   - Keeps the PHI scrubber + DSN handling co-located with the
//     scrubber test (sentry-scrubber.test.ts).
//   - Lets us no-op cleanly when `SENTRY_DSN` is unset (local dev
//     should not require Sentry).
//   - Makes the "Sentry is the source of truth for errors" contract
//     reviewable in one file.
//
// Environment gating:
//   - `SENTRY_DSN` unset → Sentry is fully disabled. The
//     `ErrorReporter` returned from `getErrorReporter()` is a no-op.
//   - `NODE_ENV === "test"` → Sentry disabled even if DSN is set, to
//     keep CI / Vitest noise out of the dashboard.
//   - Otherwise → Sentry is initialized and shipped events.

import "server-only";

import * as Sentry from "@sentry/nextjs";

import type { logger as loggerNs } from "@pharmax/platform-core";

import { buildBeforeSend, scrubBreadcrumb } from "./sentry-scrubber.js";

let initialized = false;

export interface SentryInitOptions {
  readonly dsn: string | undefined;
  readonly environment: string;
  readonly release?: string;
  readonly tracesSampleRate?: number;
  readonly profilesSampleRate?: number;
}

/**
 * Initialize Sentry once per Node process. Calling more than once is
 * a no-op so the function is safe to invoke from multiple boot paths
 * (HMR, tests).
 *
 * Returns whether Sentry was actually initialized. Callers can use
 * this to decide whether to wire `withErrorReporter` or stay on the
 * raw logger.
 */
export function initSentry(options: SentryInitOptions): boolean {
  if (initialized) return true;

  const enabled =
    options.dsn !== undefined && options.dsn.length > 0 && options.environment !== "test";

  if (!enabled) {
    return false;
  }

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    ...(options.release !== undefined ? { release: options.release } : {}),

    // Performance sampling. Default to a low rate; ramp up after
    // baseline noise is understood. Tracing is opt-in via env.
    tracesSampleRate: options.tracesSampleRate ?? 0,
    profilesSampleRate: options.profilesSampleRate ?? 0,

    // Do not auto-send default PII. We allowlist what flows through.
    sendDefaultPii: false,

    // Scrub every event before it leaves the process.
    beforeSend: buildBeforeSend({ enabledInEnvironment: enabled }),
    beforeBreadcrumb: scrubBreadcrumb,

    // Keep noise down: we'll capture our own console.error via the
    // platform-core logger bridge.
    integrations: (defaults) =>
      defaults.filter(
        (integration) =>
          integration.name !== "Console" &&
          integration.name !== "ContextLines" &&
          integration.name !== "LocalVariables"
      ),
  });

  initialized = true;
  return true;
}

/**
 * Wire Sentry as the `ErrorReporter` contract. The returned reporter
 * checks `initialized` ON EACH CALL — this lets `logger.ts` import
 * the reporter at module-load time (BEFORE `initSentry()` runs) and
 * still pick up the live state once bootstrap has fired. Returning a
 * snapshot here would permanently no-op the logger that imported it
 * pre-boot.
 */
export function createSentryErrorReporter(): loggerNs.ErrorReporter {
  return {
    captureException: (error, context) => {
      if (!initialized) return;
      const extra = context as Record<string, unknown> | undefined;
      Sentry.captureException(error, extra !== undefined ? { extra } : undefined);
    },
    captureMessage: (message, context) => {
      if (!initialized) return;
      const extra = context as Record<string, unknown> | undefined;
      Sentry.captureMessage(
        message,
        extra !== undefined ? { level: "error", extra } : { level: "error" }
      );
    },
  };
}
