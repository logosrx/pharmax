// Sentry init for the worker process.
//
// Called from `main()` BEFORE any other init step. Sentry's @sentry/node
// SDK registers global `uncaughtException` / `unhandledRejection`
// handlers on init, which is exactly what we want for a long-lived
// poll-loop process: a thrown error inside a drain tick reaches Sentry
// even if the drain's own try/catch fails.
//
// PHI scrubbing works on two different surfaces, with two different
// controls, because they fail in different directions.
//
//   - Structured metadata (`event.extra`, `event.tags`) is protected by
//     the ALLOWLIST below. An allowlist is the stronger control: a key
//     nobody anticipated is dropped rather than inspected, so the
//     default for new code is safe.
//
//   - Free text (exception messages, breadcrumbs) cannot be allowlisted,
//     because there are no keys — only prose. That surface is protected
//     by PATTERN REDACTION from `@pharmax/platform-core`.
//
// Until 2026-08-20 only the first existed here, and free text was merely
// truncated at 500 characters. The 2026 incident-response tabletop
// walked the case that exposes the difference: a carrier API error
// echoing a recipient's name and street address is well under the cap
// and was transmitted verbatim. The allowlist protecting `extra` never
// applied to it, because a stack trace has no keys.
//
// The allowlist is still inlined here rather than imported from
// apps/web: the worker is `tsx`-executed and its module boundary stays
// minimal — no React, no Next, no `apps/*` deps. The pattern redaction
// is NOT inlined, because a duplicated regex set is one that drifts, and
// the drift would be silent and in the unsafe direction.

import * as Sentry from "@sentry/node";

import { phi, type logger as loggerNs } from "@pharmax/platform-core";

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

/**
 * Cap applied to every free-text field after redaction. Matches the
 * value apps/web uses; the number is arbitrary but the two should not
 * differ without a reason.
 */
const MAX_MESSAGE_LENGTH = 500;

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
/**
 * The `beforeSend` hook, exported so it can be tested.
 *
 * It was previously an inline literal inside `Sentry.init`, which made
 * the only PHI-egress control on this process unreachable from a test.
 * The 2026 incident-response tabletop found the gap it was supposed to
 * close still open, and the reason nobody had noticed is that nothing
 * asserted the behaviour. A control that cannot be tested is a control
 * you are asserting rather than demonstrating.
 */
export function scrubWorkerEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  // Worker has no HTTP request surface — strip request data wholesale
  // if Sentry's auto-instrumentation ever populates it.
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
  // Redact BEFORE capping. Capping first lets the truncation point split
  // a match — "…Jane Smith, 123 Main St" cut at 500 leaves "123 Mai",
  // which no longer matches the address rule and would transmit as-is.
  if (event.exception?.values !== undefined) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === "string") {
        ex.value = phi.redactAndCap(ex.value, MAX_MESSAGE_LENGTH);
      }
    }
  }
  // `event.message` is the Sentry.captureMessage path. It carries the
  // same free-text exposure as an exception value and was previously
  // untouched entirely.
  if (typeof event.message === "string") {
    event.message = phi.redactAndCap(event.message, MAX_MESSAGE_LENGTH);
  }
  // Breadcrumbs are free text too, and a drain's breadcrumb trail is
  // exactly where a carrier response gets recorded on the way to the
  // exception that reports it.
  if (event.breadcrumbs !== undefined) {
    for (const crumb of event.breadcrumbs) {
      if (typeof crumb.message === "string") {
        crumb.message = phi.redactAndCap(crumb.message, MAX_MESSAGE_LENGTH);
      }
      const scrubbedData = scrubAllowlist(crumb.data);
      if (scrubbedData !== undefined) crumb.data = scrubbedData;
      else delete crumb.data;
    }
  }
  return event;
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
    // Auto-instrumentation: keep modest. Worker drains use Prisma +
    // built-in fetch; the default HTTP/Express integrations add noise
    // (no Express here). Trim to the essentials.
    integrations: (defaults) =>
      defaults.filter(
        (i) => i.name !== "Console" && i.name !== "ContextLines" && i.name !== "LocalVariables"
      ),
    beforeSend: scrubWorkerEvent,
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
