// Pino-backed Logger for the web tier, with Sentry bridge.
//
// Two layers:
//
//   1. `createPinoLogger` → structured JSON to stdout, with the
//      platform-core default PHI redaction allowlist. This is the
//      developer-visible log line.
//   2. `withErrorReporter` → wraps the Pino logger so every
//      `.error(...)` call ALSO fires `Sentry.captureException` /
//      `captureMessage`. The reporter is the Sentry adapter built
//      by `createSentryErrorReporter`. When Sentry is not
//      initialized (no DSN, or NODE_ENV=test), the reporter is a
//      no-op and behavior is identical to the pre-bridge logger.
//
// Bindings:
//   - `service: "pharmacy-os"` (matches `apps/web/package.json#name`)
//   - per-component children added via `logger.child({ component: ... })`
//     at the call site (route handler, billing wiring, etc.)
//
// PHI invariant carries through: the Pino redactor scrubs the
// context BEFORE Sentry receives it (see `error-reporter.ts`), and
// the Sentry `beforeSend` allowlist (see `sentry-scrubber.ts`)
// is the second line of defense.

import "server-only";

import { logger as loggerNs } from "@pharmax/platform-core";

import { env } from "./env.js";
import { createSentryErrorReporter } from "./observability/sentry-init.js";

const basePinoLogger = loggerNs.createPinoLogger({
  service: "pharmacy-os",
  level: env.LOG_LEVEL,
});

// `createSentryErrorReporter` returns a no-op until `initSentry()` has
// been called. That happens in `bootstrap()` BEFORE the first request,
// so by the time any call site does `logger.error(...)`, the reporter
// is wired (or intentionally no-op'd because Sentry is disabled).
export const logger = loggerNs.withErrorReporter(basePinoLogger, createSentryErrorReporter());
