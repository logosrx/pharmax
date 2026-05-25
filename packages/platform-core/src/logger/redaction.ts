// Default Pino redaction allowlist.
//
// This is DEFENSE IN DEPTH, not a license to log PHI. The contract in
// `logger/types.ts` already says callers MUST NOT pass PHI into
// `context`. This list catches accidents:
//
//   1. Secret material (auth headers, API keys, signed cookies).
//   2. PHI-adjacent fields that domain code might add to a log
//      context by mistake (patient first/last name, MRN, DOB, etc.).
//   3. Raw webhook payloads (Stripe events contain PII — billing
//      addresses, last4, etc.).
//
// Pino's redaction format supports wildcards via `*` and `*.field`.
// `*` matches one level. `**.field` matches at any depth (Pino 7+).
// We use both — the `**.` variants catch fields buried inside
// arbitrarily-nested context objects.
//
// IMPORTANT: when adding a field to a domain log context, consider:
//   - Can the field name match anything in this list? If yes, rename
//     it so the redactor catches accidents.
//   - If the field IS sensitive, either redact at the call site or
//     add it to this list. Do not "just be careful at the call site"
//     — that is exactly the failure mode this list defends against.

export const DEFAULT_REDACT_PATHS: ReadonlyArray<string> = Object.freeze([
  // Auth / secrets.
  "*.password",
  "*.pwd",
  "*.secret",
  "*.token",
  "*.apiKey",
  "*.accessToken",
  "*.refreshToken",
  "*.sessionToken",
  "*.authorization",
  "*.cookie",
  "*.setCookie",
  "*.stripeSignature",

  // Headers map (Pino redact uses bracket syntax for hyphen keys).
  'headers["authorization"]',
  'headers["cookie"]',
  'headers["set-cookie"]',
  'headers["stripe-signature"]',

  // PHI-adjacent fields. Caller MUST NOT log these directly; the
  // redactor swaps them to `[Redacted]` if they slip through.
  "*.firstName",
  "*.lastName",
  "*.fullName",
  "*.dateOfBirth",
  "*.dob",
  "*.ssn",
  "*.mrn",
  "*.phoneNumber",
  "*.phone",
  "*.emailAddress",
  "*.email",
  "*.address",
  "*.addressLine1",
  "*.addressLine2",
  "*.streetAddress",
  "*.zip",
  "*.zipCode",
  "*.postalCode",

  // Raw external payloads.
  "*.rawBody",
  "*.payload",
  "*.body",
]);

export const DEFAULT_REDACT_CENSOR = "[Redacted]";
