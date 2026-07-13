// Deterministic request hashing for idempotency matching.
//
// Two requests are "the same" iff their canonical JSON encoding is
// byte-identical. Canonical = recursively sort object keys before
// stringify. This makes `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` hash
// to the same value, which is what callers expect.
//
// The bus hashes the FULL (pre-redaction) payload with a keyed
// HMAC (`hashRequestKeyed`). Hashing the redacted payload — the
// previous design — collapsed every PHI-bearing request into the
// same `"[Redacted]"` bytes, so two DIFFERENT patients under a
// reused idempotency key hashed identically and the second request
// silently replayed the first patient's response. Hashing the full
// payload restores collision detection; keying the hash with a
// KMS-derived secret keeps the stored `idempotency_key.requestHash`
// non-reversible (an attacker who reads the table cannot
// dictionary-attack low-entropy PHI like name+DOB without the key).

import { createHash, createHmac } from "node:crypto";

import { getCommandBusConfiguration } from "./configure.js";

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

/**
 * Keyed request hash — HMAC-SHA256 over the canonical JSON encoding.
 * The executor uses this (with the configured `requestHashKey`) so
 * the stored hash is both collision-correct (full payload, not the
 * redacted projection) and non-reversible without the key.
 */
export function hashRequestKeyed(payload: unknown, key: string | Buffer): string {
  return createHmac("sha256", key).update(canonicalStringify(payload)).digest("hex");
}

/**
 * Fallback HMAC key used when the bus configuration carries no
 * `requestHashKey` (bare test wirings). Publicly known — hashes
 * stay deterministic and collision-correct but are NOT secret.
 * Production always supplies a KMS-derived key via the composition
 * root.
 */
export const FALLBACK_REQUEST_HASH_KEY = "pharmax.command-bus.request-hash.unkeyed.v2";

/**
 * Short payload fingerprint for building idempotency KEYS (not the
 * stored request hash). Route handlers append this to their key
 * prefix so two DIFFERENT payloads submitted under the same route
 * prefix in the same dedupe window get DIFFERENT keys (and both
 * execute), while a true double-submit of the SAME payload reuses
 * the key and replays.
 *
 * Keyed with the configured `requestHashKey` so a stored key
 * fragment cannot be dictionary-attacked back to payload contents.
 * 16 hex chars (64 bits) — collision-safe for a per-route,
 * per-minute namespace.
 */
export function fingerprintRequest(payload: unknown): string {
  const key = getCommandBusConfiguration().requestHashKey ?? FALLBACK_REQUEST_HASH_KEY;
  return hashRequestKeyed(payload, key).slice(0, 16);
}
