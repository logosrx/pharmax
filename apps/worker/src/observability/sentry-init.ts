// Sentry init for the worker process.
//
// Called from `main()` BEFORE any other init step. Sentry's @sentry/node
// SDK registers global `uncaughtException` / `unhandledRejection`
// handlers on init, which is exactly what we want for a long-lived
// poll-loop process: a thrown error inside a drain tick reaches Sentry
// even if the drain's own try/catch fails.
//
// PHI scrubbing: identical philosophy to apps/web. The allowlist of
// metadata keys is inlined here (rather than imported from apps/web)
// because the worker package is `tsx`-executed and we keep its module
// boundary minimal — no React, no Next, no shared `apps/*` deps. If
// the allowlist drifts, add a contract test in
// `packages/integration-tests` that exercises both.

import * as Sentry from "@sentry/node";

import type { logger as loggerNs } from "@pharmax/platform-core";

const ALLOWED_METADATA_KEYS: ReadonlySet<string> = new Set([
  "organizationId",
  "siteId",
  "clinicId",
  "teamId",
  "workstationId",
  "actorUserId",
  "correlationId",
  "commandLogId",
  "intervalId",
  "orderId",
  "orderLineId",
  "printJobId",
  "shipmentId",
  "credentialId",
  "stripeEventId",
  "eventOutboxId",
  "eventType",
  "commandName",
  "code",
  "status",
  "kind",
  "outcome",
  "operation",
  "provider",
  "carrier",
  "serviceLevel",
  "level",
  "component",
  "service",
  "loop",
  "errorMessage",
  "failureReason",
  "attempt",
  "count",
  "size",
  "durationMs",
  "intervalMs",
  "timeoutMs",
  "pollIntervalMs",
  "shutdownTimeoutMs",
  "ok",
  "processed",
  "nodeEnv",
  "pid",
  "signal",
  "cryptoAdapter",
  "zplMode",
]);

let initialized = false;

export interface SentryInitOptions {
  readonly dsn: string | undefined;
  readonly environment: string;
  readonly release?: string;
  readonly tracesSampleRate?: number;
  readonly serverName?: string;
}

/**
 * Initialize Sentry once per process. Safe to call multiple times.
 * Returns whether Sentry was actually initialized.
 */
export function initSentry(options: SentryInitOptions): boolean {
  if (initialized) return true;

  const enabled =
    options.dsn !== undefined && options.dsn.length > 0 && options.environment !== "test";

  if (!enabled) return false;

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    ...(options.release !== undefined ? { release: options.release } : {}),
    ...(options.serverName !== undefined ? { serverName: options.serverName } : {}),
    tracesSampleRate: options.tracesSampleRate ?? 0,
    sendDefaultPii: false,
    // Auto-instrumentation: keep modest. Worker drains use Prisma +
    // built-in fetch; the default HTTP/Express integrations add noise
    // (no Express here). Trim to the essentials.
    integrations: (defaults) =>
      defaults.filter(
        (i) => i.name !== "Console" && i.name !== "ContextLines" && i.name !== "LocalVariables"
      ),
    beforeSend(event) {
      // Worker has no HTTP request surface — strip request data
      // wholesale if Sentry's auto-instrumentation ever populates it.
      delete event.request;
      if (event.user !== undefined) {
        const { id } = event.user;
        if (id !== undefined) {
          event.user = { id };
        } else {
          delete event.user;
        }
      }
      const scrubbedExtra = scrubAllowlist(event.extra);
      if (scrubbedExtra !== undefined) event.extra = scrubbedExtra;
      else delete event.extra;
      const scrubbedTags = scrubAllowlist(event.tags as Record<string, unknown> | undefined);
      if (scrubbedTags !== undefined) {
        event.tags = scrubbedTags as unknown as NonNullable<typeof event.tags>;
      } else {
        delete event.tags;
      }
      if (event.exception?.values !== undefined) {
        for (const ex of event.exception.values) {
          if (typeof ex.value === "string" && ex.value.length > 500) {
            ex.value = `${ex.value.slice(0, 500)}…`;
          }
        }
      }
      return event;
    },
  });

  initialized = true;
  return true;
}

function scrubAllowlist(
  bag: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (bag === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) {
    if (ALLOWED_METADATA_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Build the `ErrorReporter` adapter. Returns a live reporter that
 * checks `initialized` on each call — same lazy pattern as apps/web.
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

/**
 * Flush pending Sentry events on shutdown. Returns whether all events
 * were sent within the timeout. The worker's main loop should await
 * this before `process.exit(0)`.
 */
export async function flushSentry(timeoutMs: number): Promise<boolean> {
  if (!initialized) return true;
  return Sentry.close(timeoutMs);
}
