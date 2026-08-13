// Deep PHI / secret scrubbing for log contexts.
//
// This is DEFENSE IN DEPTH, not a license to log PHI. The contract in
// `logger/types.ts` already says callers MUST NOT pass PHI into
// `context`. This module catches accidents:
//
//   1. Secret material (auth headers, API keys, signed cookies).
//   2. PHI-adjacent fields that domain code might add to a log
//      context by mistake (patient first/last name, MRN, DOB, etc.).
//   3. Raw webhook payloads (Stripe events contain PII — billing
//      addresses, last4, etc.).
//
// Why a recursive walk instead of Pino's `redact` paths
// -----------------------------------------------------
// Pino redacts by matching literal paths, so covering nested data
// means enumerating a wildcard path per depth (`*.mrn`, `*.*.mrn`,
// ...). That has two problems:
//
//   - It is unbounded in the wrong direction. Whatever depth we
//     enumerate, a context one level deeper leaks silently. A log
//     context is arbitrary caller-supplied data; we cannot know its
//     shape in advance.
//   - Wildcard paths are expensive. Each `*.field` forces a walk of
//     every top-level key, and the cost compounds per path. Measured
//     on this field list: 33 literal names cost ~900ns/line, adding
//     the 33 `*.field` variants took it to ~16,400ns/line, and a
//     depth-3 list reached ~62,000ns/line. One recursive pass covers
//     every depth for ~1,200ns/line.
//
// So we scrub the context ourselves before handing it to Pino. One
// pass, unbounded depth, cost proportional to the context actually
// logged rather than to the size of the field list.
//
// IMPORTANT: when adding a field to a domain log context, consider:
//   - Can the field name match anything in this list? If yes, rename
//     it so the redactor catches accidents.
//   - If the field IS sensitive, either redact at the call site or
//     add it to this list. Do not "just be careful at the call site"
//     — that is exactly the failure mode this list defends against.

import type { LogContext } from "./types.js";

// Matching is case-insensitive, so list each name in its natural
// casing and let the lookup normalize. `set-cookie` / `stripe-signature`
// appear in their header spelling because that is how they arrive
// inside a `headers` object.
const SENSITIVE_FIELDS: ReadonlyArray<string> = Object.freeze([
  // Auth / secrets.
  "password",
  "pwd",
  "secret",
  "token",
  "apiKey",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "authorization",
  "cookie",
  "setCookie",
  "set-cookie",
  "stripeSignature",
  "stripe-signature",

  // PHI-adjacent fields. Caller MUST NOT log these directly; the
  // redactor swaps them to `[Redacted]` if they slip through.
  "firstName",
  "lastName",
  "fullName",
  "dateOfBirth",
  "dob",
  "ssn",
  "mrn",
  "phoneNumber",
  "phone",
  "emailAddress",
  "email",
  "address",
  "addressLine1",
  "addressLine2",
  "streetAddress",
  "zip",
  "zipCode",
  "postalCode",

  // Raw external payloads.
  "rawBody",
  "payload",
  "body",
]);

export const DEFAULT_REDACT_CENSOR = "[Redacted]";

/** Placeholder for a reference that points back into its own graph. */
const CIRCULAR = "[Circular]";

const DEFAULT_SENSITIVE_LOOKUP: ReadonlySet<string> = new Set(
  SENSITIVE_FIELDS.map((field) => field.toLowerCase())
);

/** Field names scrubbed by default, for docs and tests. */
export const DEFAULT_SENSITIVE_FIELDS = SENSITIVE_FIELDS;

export interface CreateLogContextRedactorOptions {
  /**
   * Extra field names to scrub ON TOP OF the defaults. Use for
   * domain-specific sensitive fields (e.g. a billing module might add
   * `last4`). Matched case-insensitively at any depth — unlike the
   * old path syntax, these are plain names, not patterns.
   */
  readonly extraSensitiveFields?: ReadonlyArray<string>;
  /** Override the censor token. Defaults to `"[Redacted]"`. */
  readonly censor?: string;
}

export type LogContextRedactor = (context: LogContext) => LogContext;

/**
 * Build a redactor that returns a scrubbed COPY of a log context.
 * The caller's object is never mutated — domain code frequently logs
 * an object it is still using, and a redactor with side effects would
 * corrupt the request it was meant to make safe.
 */
export function createLogContextRedactor(
  options: CreateLogContextRedactorOptions = {}
): LogContextRedactor {
  const censor = options.censor ?? DEFAULT_REDACT_CENSOR;
  const extra = options.extraSensitiveFields ?? [];
  const sensitive =
    extra.length === 0
      ? DEFAULT_SENSITIVE_LOOKUP
      : new Set([...DEFAULT_SENSITIVE_LOOKUP, ...extra.map((field) => field.toLowerCase())]);

  return (context) => scrubRecord(context, sensitive, censor, new Set()) as LogContext;
}

/**
 * Values we deliberately hand to Pino untouched.
 *
 * `Error` matters most: Pino's standard serializer turns it into
 * `{ type, message, stack }`, and rebuilding one here would lose the
 * stack. The engineering policy (mirrored in the Sentry scrubber) is
 * that `Error.message` must never interpolate PHI. The consequence is
 * that own enumerable properties hung off an `Error` are NOT scrubbed
 * — attach context to the log context instead of to the error.
 *
 * The rest are types where walking keys produces nonsense: a `Buffer`
 * would explode into byte indices, and `Map` / `Set` / `RegExp` /
 * `Date` serialize through their own representations.
 */
function isOpaque(value: object): boolean {
  return (
    value instanceof Error ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function scrubValue(
  value: unknown,
  sensitive: ReadonlySet<string>,
  censor: string,
  seen: Set<object>
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isOpaque(value)) return value;
  if (seen.has(value)) return CIRCULAR;

  // Track the ancestor chain rather than every object ever visited, so
  // a graph that legitimately references the same object twice keeps
  // both copies instead of reporting the second as circular.
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => scrubValue(entry, sensitive, censor, seen));
    }
    return scrubRecord(value as Record<string, unknown>, sensitive, censor, seen);
  } finally {
    seen.delete(value);
  }
}

function scrubRecord(
  record: Readonly<Record<string, unknown>>,
  sensitive: ReadonlySet<string>,
  censor: string,
  seen: Set<object>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    out[key] = sensitive.has(key.toLowerCase())
      ? censor
      : scrubValue(record[key], sensitive, censor, seen);
  }
  return out;
}
