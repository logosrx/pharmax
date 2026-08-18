// PHI-safe Sentry scrubbing — runtime-agnostic core.
//
// This module deliberately contains NO `server-only` import and no
// Node built-ins, because all three Sentry runtimes need it: the
// Node server (`src/server/observability/sentry-scrubber.ts` re-exports
// it), the browser SDK, and the Edge SDK.
//
// That split is the point. The browser and Edge configs previously ran
// with Sentry's default scrubbing alone, on the stated reasoning that a
// custom `beforeSend` "would need a separate hook that knows nothing
// about server tenancy context." True — and it turns out it does not
// need any. Everything here is a static allowlist and a set of regexes;
// none of it reads tenancy, environment, or request state. The gap was
// a packaging problem, not a design constraint.
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
// Philosophy: ALLOWLIST for structured bags, PATTERN REDACTION for free
// text. Structured data has known key names, so anything unlisted is
// dropped. Free text has no keys to check, so it gets swept for the
// shapes PHI actually takes.

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

/** Exception values are capped after redaction so one runaway string cannot dominate an event. */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Shapes PHI takes inside free text, and the stable token each is
 * replaced with.
 *
 * Order matters. SSN runs before the phone sweep so a `123-45-6789`
 * is not partially consumed, and the street-address sweep runs before
 * the bare-date rules so a house number is not mistaken for anything
 * else.
 *
 * These are deliberately blunt. A false positive costs a little
 * debugging context; a false negative is a disclosure to a third
 * party. When those two are the choices, over-redaction wins.
 */
const PHI_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  // Most specific digit shapes first, so a looser rule cannot consume
  // part of one and leave a fragment behind.
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/\b\d{5}-\d{4}\b/g, "[zip]"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  // The boundary here is a negative lookbehind rather than `\b`,
  // because `\b` sits between two word characters and a leading `(`
  // is not one — anchoring with `\b` left the paren stranded outside
  // the match, emitting `([phone]`. Excluding a preceding digit or
  // hyphen also stops the rule reaching into a UUID segment.
  [/(?<![\d-])(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/g, "[phone]"],
  [
    /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Highway|Hwy)\b\.?/gi,
    "[address]",
  ],
  // A bare calendar date is the shape a date of birth takes. The
  // negative lookahead spares ISO timestamps, which are pure debugging
  // value and never a birth date.
  [/\b\d{4}-\d{2}-\d{2}\b(?!T)/g, "[date]"],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "[date]"],
] as ReadonlyArray<readonly [RegExp, string]>);

/**
 * Sweep PHI shapes out of a free-text string.
 *
 * The previous position was that exception messages could not be
 * scrubbed because doing so "would destroy the grouping fingerprint",
 * leaving call-site discipline as the only control and a length cap as
 * the backstop. Call-site discipline is exactly the control that fails
 * — nobody writes `throw new Error(patient.firstName)` on purpose, and
 * a carrier's API error message is not written by us at all.
 *
 * Replacing a match with a STABLE token is what makes this safe for
 * grouping, and in fact improves it. `Recipient jane@x.com not found`
 * and `Recipient bob@y.com not found` are two Sentry issues today;
 * redacted, they are one. Variable content is precisely what should
 * not be in a fingerprint.
 */
export function redactPhiPatterns(text: string): string {
  let out = text;
  for (const [pattern, token] of PHI_PATTERNS) {
    // Each regex is a module-level literal with the `g` flag, so
    // `lastIndex` must not leak between calls. `String.replace` with a
    // global regex resets it, but reassigning keeps that explicit.
    out = out.replace(pattern, token);
  }
  return out;
}

/** Redact, then cap. Capping first would let a truncation point split a match. */
function redactAndCap(text: string): string {
  const redacted = redactPhiPatterns(text);
  return redacted.length > MAX_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}…`
    : redacted;
}

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
      // An allowlisted key can still hold free text — `errorMessage`
      // and `failureReason` are documented as "sanitized at call
      // sites", which is the same trust this module exists to stop
      // relying on.
      out[key] = typeof value === "string" ? redactAndCap(value) : value;
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
  if (typeof next.message === "string") {
    next.message = redactAndCap(next.message);
  }
  if (next.data !== undefined) {
    const scrubbedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next.data)) {
      if (key === "url" && typeof value === "string") {
        scrubbedData[key] = scrubUrl(value);
      } else if (ALLOWED_METADATA_KEYS.has(key)) {
        scrubbedData[key] = typeof value === "string" ? redactAndCap(value) : value;
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

    // 5. Free text: the exception value and the top-level message.
    //
    // `Error.message` is where PHI arrives without anyone deciding to
    // put it there. A carrier's rating API rejects an address and
    // echoes it back; `wrapFedExError` forwards `cause.message`
    // verbatim into the wrapped error. Nothing in that chain is ours
    // to discipline, so it is swept here at the egress boundary
    // instead — one place, covering every adapter.
    if (event.exception?.values !== undefined) {
      for (const ex of event.exception.values) {
        if (typeof ex.value === "string") {
          ex.value = redactAndCap(ex.value);
        }
      }
    }
    if (typeof event.message === "string") {
      event.message = redactAndCap(event.message);
    }

    return event;
  };
}

/** @internal exposed for tests only */
export const __testing = {
  ALLOWED_METADATA_KEYS,
  scrubUrl,
  scrubObjectByAllowlist,
  redactAndCap,
  MAX_MESSAGE_LENGTH,
};
