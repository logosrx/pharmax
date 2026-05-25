// Sentry init for the print-agent process.
//
// Mirrors apps/worker's Sentry init — same PHI allowlist, same lazy
// `ErrorReporter` adapter pattern. The print-agent runs on
// pharmacy-floor workstations, so reliability here matters: a silent
// crash means no labels get printed. Sentry's auto-registered
// uncaughtException / unhandledRejection handlers turn that silent
// failure into an alert.

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
  "eventType",
  "commandName",
  "code",
  "status",
  "kind",
  "outcome",
  "operation",
  "provider",
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
  "printerId",
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
    integrations: (defaults) =>
      defaults.filter(
        (i) => i.name !== "Console" && i.name !== "ContextLines" && i.name !== "LocalVariables"
      ),
    beforeSend(event) {
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

export async function flushSentry(timeoutMs: number): Promise<boolean> {
  if (!initialized) return true;
  return Sentry.close(timeoutMs);
}
