// Field readers for operator action routes.
//
// Every ops route accepts both a browser form POST and a JSON body (see
// `parse-request-body.ts`), so every field read has to handle FormData
// and a plain record. That branch was being rewritten in each route,
// and the enum-valued reads were the ones that went wrong: a route that
// reads `verificationMethod` as a bare string and passes it to a
// command types only because of a cast, and a cast is exactly what lets
// `?verificationMethod=whatever` reach the domain.
//
// `readEnumField` narrows to the literal union instead, so an
// unrecognised value is `null` at the boundary and the route turns it
// into a flash message. No casts in the routes.

import "server-only";

/** Either body shape `parseOpsRequestBody` can produce. */
export type OpsBody = FormData | Record<string, unknown>;

function rawValue(body: OpsBody, key: string): unknown {
  return body instanceof FormData ? body.get(key) : body[key];
}

function rawValues(body: OpsBody, key: string): readonly unknown[] {
  if (body instanceof FormData) return body.getAll(key);
  const raw = body[key];
  if (Array.isArray(raw)) return raw;
  return raw === undefined || raw === null ? [] : [raw];
}

/**
 * A trimmed non-empty string, or null. An omitted field and a field
 * submitted empty are the same thing: browsers post empty strings for
 * untouched optional inputs, and a command's optional field wants the
 * key absent rather than `""`.
 */
export function readStringField(body: OpsBody, key: string): string | null {
  const raw = rawValue(body, key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A value narrowed to one of `allowed`, or null if absent or
 * unrecognised. Callers cannot tell those two cases apart, which is
 * intentional — both produce the same operator-facing refusal, and
 * distinguishing them would tempt a route into echoing the rejected
 * value back into a flash message.
 */
export function readEnumField<T extends string>(
  body: OpsBody,
  key: string,
  allowed: readonly T[]
): T | null {
  const raw = readStringField(body, key);
  if (raw === null) return null;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/**
 * Repeated values narrowed to `allowed`, deduplicated, order preserved.
 * This is the checkbox-group read: several inputs share one name, and
 * an unchecked group posts nothing at all.
 *
 * Unrecognised entries are dropped rather than failing the whole read.
 * The caller decides whether an empty result is an error — for a
 * schedule list it is, for a declarative set-of-states write an empty
 * set is a legitimate instruction.
 */
export function readEnumListField<T extends string>(
  body: OpsBody,
  key: string,
  allowed: readonly T[]
): readonly T[] {
  const permitted = new Set<string>(allowed);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const raw of rawValues(body, key)) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!permitted.has(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed as T);
  }
  return out;
}

/**
 * Repeated free-text values, trimmed, non-empty, deduplicated. For sets
 * whose members are validated by the domain rather than by an enum —
 * the authorized ship states, where the command is the authority on
 * which states have a licence behind them.
 */
export function readStringListField(body: OpsBody, key: string): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawValues(body, key)) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
