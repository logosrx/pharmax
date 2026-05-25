// Pino-backed Logger for the worker process, bridged to Sentry.
//
// Mirrors apps/web's logger so both surfaces produce structured JSON
// with the same shape and the same PHI-aware redaction allowlist.
// Tail them together with `docker compose logs -f` and pipe through
// `jq` or `pnpm dlx pino-pretty` for readability in dev.
//
// Every `.error(...)` call also forwards to Sentry via the
// `ErrorReporter` bridge. When Sentry is not initialized (no DSN, or
// NODE_ENV=test), the reporter is a no-op and behavior is identical
// to the pre-bridge logger.

import { logger as loggerNs } from "@pharmax/platform-core";

import { env } from "./env.js";
import { createSentryErrorReporter } from "./observability/sentry-init.js";

const basePinoLogger = loggerNs.createPinoLogger({
  service: "pharmacy-worker",
  level: env.LOG_LEVEL,
});

export const logger = loggerNs.withErrorReporter(basePinoLogger, createSentryErrorReporter());
