// PHI-safe Sentry beforeSend / beforeBreadcrumb scrubber.
//
// Sentry receives error events with request data, breadcrumbs, user
// context, and arbitrary `extra` / `tags` fields. In a pharmacy
// platform, ANY of those can carry PHI if a developer slips up:
//
//   - A `404` on `/api/patients/[id]` may put a patient id in `request.url`.
//   - A captured `Error.message` may interpolate a name or DOB.
//   - A breadcrumb from a `fetch` to `/v2/patients?search=...` may
//     embed the search term.
//   - `request.headers` may carry cookies / authorization tokens.
//
// Pino's redactor (see @pharmax/platform-core/logger/redaction) already
// scrubs the structured context that flows through `Logger.error`.
// Sentry sees a SUPERSET of what the logger sees — it also receives
// transport-level metadata (request, response, breadcrumbs) — so we
// need a second scrubbing layer here.
//
// Philosophy: ALLOWLIST, not denylist. Anything not on the allowlist
// is dropped. A denylist would inevitably miss something the day a
// new field arrives.
//
// Tests: `sentry-scrubber.test.ts` exercises every code path. When
// adding a new allowed key, update both the constant below AND the
// test.

import "server-only";

// Sentry v8 consolidated the public types into `@sentry/core`. The
// historical `@sentry/types` package is now a thin re-export. We
// import from `@sentry/core` directly to stay on the supported path.
// `ErrorEvent` is the discriminated subtype that `beforeSend` sees —
// Sentry v8 splits it from `TransactionEvent` so a single hook can be
// typed against one or the other.
import type { ErrorEvent, EventHint, Breadcrumb, Context } from "@sentry/core";

/**
 * `extra` / `tags` / `contexts` keys allowed to pass through to
 * Sentry. Anything not on this list is dropped during `beforeSend`.
 *
 * Adding a key here is a PHI risk — review the call sites that
 * populate it and make sure nothing user-controlled flows in.
 */
const ALLOWED_METADATA_KEYS: ReadonlySet<string> = new Set([
  // Identity / tenancy — non-PHI opaque ids.
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
  // Domain-event metadata — non-PHI enum values.
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
  "errorMessage", // sanitized at call sites, capped length
  "failureReason", // sanitized at call sites, capped length
  // Counters / numerics — never PHI.
  "attempt",
  "count",
  "size",
  "durationMs",
  "intervalMs",
  "timeoutMs",
  "pollIntervalMs",
  "shutdownTimeoutMs",
  // Booleans / states.
  "ok",
  "processed",
  // Build / runtime info.
  "nodeEnv",
  "pid",
  "signal",
  "cryptoAdapter",
  "zplMode",
]);

const REDACTED = "[Redacted]";

/**
 * URL query strings often carry search terms (PHI-adjacent). Strip
 * them; keep the path so we still know which route blew up.
 */
function scrubUrl(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

/**
 * Allowlist the metadata bag — anything not explicitly listed gets
 * dropped. `undefined` / `null` is fine to drop silently.
 */
function scrubObjectByAllowlist(
  bag: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (bag === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (ALLOWED_METADATA_KEYS.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Breadcrumbs are short auto-captured events (XHR, console, navigation).
 * Sentry captures them by default. We scrub URLs and drop bodies.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // Console breadcrumbs frequently carry user-supplied strings; drop
  // anything beyond the level + a generic category.
  if (breadcrumb.category === "console") {
    return {
      type: breadcrumb.type,
      category: breadcrumb.category,
      level: breadcrumb.level,
      message: REDACTED,
      timestamp: breadcrumb.timestamp,
    };
  }

  const next: Breadcrumb = { ...breadcrumb };
  if (next.data !== undefined) {
    const scrubbedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next.data)) {
      if (key === "url" && typeof value === "string") {
        scrubbedData[key] = scrubUrl(value);
      } else if (ALLOWED_METADATA_KEYS.has(key)) {
        scrubbedData[key] = value;
      }
    }
    next.data = scrubbedData;
  }
  return next;
}

/**
 * Sentry `beforeSend` hook. Mutate/replace the event before it leaves
 * the process. Returning `null` drops the event entirely (useful in
 * test environments).
 */
export function buildBeforeSend(options: {
  readonly enabledInEnvironment: boolean;
}): (event: ErrorEvent, hint: EventHint) => ErrorEvent | null {
  return (event, _hint) => {
    if (!options.enabledInEnvironment) {
      return null;
    }

    // 1. Strip request data we never want to send.
    if (event.request !== undefined) {
      const { request } = event;
      const next = { ...request } as typeof request;

      if (typeof next.url === "string") {
        next.url = scrubUrl(next.url);
      }
      // Headers can carry cookies / authorization. Drop wholesale —
      // the Pino redactor handles the same paths in logs.
      delete next.headers;
      delete next.cookies;
      // Request bodies are the highest-risk surface — Stripe events,
      // patient JSON, etc. NEVER ship them.
      delete next.data;
      delete next.query_string;

      event.request = next;
    }

    // 2. User context — we don't set PII fields, but defensively
    // strip anything beyond the opaque id.
    if (event.user !== undefined) {
      const { id } = event.user;
      if (id !== undefined) {
        event.user = { id };
      } else {
        delete event.user;
      }
    }

    // 3. Allowlist `extra`, `tags`, and `contexts`. Under
    // `exactOptionalPropertyTypes: true` we must `delete` rather than
    // assign `undefined` — Sentry's optional fields reject `undefined`.
    const scrubbedExtra = scrubObjectByAllowlist(event.extra);
    if (scrubbedExtra !== undefined) event.extra = scrubbedExtra;
    else delete event.extra;
    const scrubbedTags = scrubObjectByAllowlist(event.tags as Record<string, unknown> | undefined);
    if (scrubbedTags !== undefined) {
      event.tags = scrubbedTags as unknown as NonNullable<typeof event.tags>;
    } else {
      delete event.tags;
    }
    if (event.contexts !== undefined) {
      // Sentry's `Contexts` type narrows known keys (runtime, os, etc.)
      // to specialized shapes (e.g. `TraceContext` requires `trace_id`).
      // We pass those through untouched, so the original typed value
      // is valid — but iterating via `Object.entries` widens to
      // `Context`. Use a loose intermediate then cast once at the end.
      const nextContexts: Record<string, Context> = {};
      for (const [key, ctx] of Object.entries(event.contexts)) {
        if (ctx === undefined) continue;
        if (key === "runtime" || key === "os" || key === "device" || key === "trace") {
          nextContexts[key] = ctx;
        } else if (ctx !== null && typeof ctx === "object") {
          const scrubbed = scrubObjectByAllowlist(ctx as Record<string, unknown>);
          if (scrubbed !== undefined) nextContexts[key] = scrubbed;
        }
      }
      event.contexts = nextContexts as unknown as NonNullable<ErrorEvent["contexts"]>;
    }

    // 4. Scrub breadcrumbs.
    if (Array.isArray(event.breadcrumbs)) {
      const scrubbed: Breadcrumb[] = [];
      for (const crumb of event.breadcrumbs) {
        const next = scrubBreadcrumb(crumb);
        if (next !== null) scrubbed.push(next);
      }
      event.breadcrumbs = scrubbed;
    }

    // 5. The exception value (Error.message) may interpolate PHI. We
    // can't scrub it generically because doing so would destroy the
    // grouping fingerprint. Engineering policy: never throw with PHI
    // in `Error.message`. The Pino redactor catches accidents in
    // logs, but Sentry needs `error.message` to dedupe. We trust the
    // call-site discipline here AND add a length cap as a backstop.
    if (event.exception?.values !== undefined) {
      for (const ex of event.exception.values) {
        if (typeof ex.value === "string" && ex.value.length > 500) {
          ex.value = `${ex.value.slice(0, 500)}…`;
        }
      }
    }

    return event;
  };
}

/** @internal exposed for tests only */
export const __testing = {
  ALLOWED_METADATA_KEYS,
  scrubUrl,
  scrubObjectByAllowlist,
};
