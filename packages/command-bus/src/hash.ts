// Deterministic request hashing for idempotency matching.
//
// Two requests are "the same" iff their canonical JSON encoding is
// byte-identical. Canonical = recursively sort object keys before
// stringify. This makes `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` hash
// to the same value, which is what callers expect.
//
// We hash the post-redaction payload (so the stored hash in
// `idempotency_key.requestHash` matches what's stored in
// `command_log.requestPayload`). That keeps replay-detection PHI-
// free: an attacker who reads `idempotency_key` cannot reconstruct
// the patient identifier the original request contained.

import { createHash } from "node:crypto";

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, replacer(value));
}

function replacer(_root: unknown) {
  return function (_key: string, val: unknown): unknown {
    if (val === null || val === undefined) return val;
    if (typeof val !== "object" || Array.isArray(val)) return val;
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(val as Record<string, unknown>).sort();
    for (const k of keys) {
      sorted[k] = (val as Record<string, unknown>)[k];
    }
    return sorted;
  };
}

export function hashRequest(payload: unknown): string {
  return createHash("sha256").update(canonicalStringify(payload)).digest("hex");
}
