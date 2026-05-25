// PHI redaction for command_log payloads.
//
// Scope (Phase 1):
//   - Top-level key allowlist: any key in `redactFields` is replaced
//     with the censor token `"[Redacted]"` BEFORE the payload is
//     stringified into `command_log.requestPayload` /
//     `responsePayload`.
//   - A small set of ALWAYS-redact keys (password, ssn, etc.) is
//     enforced regardless of per-command declarations — defense in
//     depth against handlers that forget to declare.
//
// Out of scope (Phase 1):
//   - Nested-path redaction (e.g. `"patient.firstName"`). Phase 2
//     extends with dotted paths.
//   - Zod `.brand("phi")` declarative markers — Phase 2.
//
// The function is PURE. It clones the input and returns a NEW
// object; the caller's payload is never mutated.

const CENSOR = "[Redacted]";

const ALWAYS_REDACT: ReadonlySet<string> = new Set([
  "password",
  "passwordHash",
  "pwd",
  "secret",
  "token",
  "apiKey",
  "accessToken",
  "refreshToken",
  "ssn",
  "dob",
  "dateOfBirth",
  "mrn",
  "stripeSignature",
  "authorization",
  "cookie",
]);

/**
 * Returns a shallow-cloned payload with `redactFields` and the
 * always-redact keys replaced by `"[Redacted]"`. Non-object inputs
 * are returned wrapped as `{ value: input }` so they're loggable
 * as JSON.
 */
export function redactPayload(
  payload: unknown,
  redactFields: ReadonlyArray<string> = []
): Record<string, unknown> {
  if (payload === null || payload === undefined) {
    return {};
  }
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return { value: payload };
  }
  const declared = new Set(redactFields);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (ALWAYS_REDACT.has(key) || declared.has(key)) {
      out[key] = CENSOR;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const REDACT_CENSOR = CENSOR;
