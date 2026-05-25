// Ciphertext envelope — the stored projection of an encrypted field.
//
// Wire format:
//
//     {
//       "v":    1,                       // envelope version
//       "alg":  "AES-256-GCM",           // field-cipher algorithm
//       "kek":  "kek:org-x:v3",          // KEK identifier (tenant + version)
//       "wDek": "<base64url>",           // KEK-wrapped data key
//       "iv":   "<base64url>",           // 12-byte IV for the field cipher
//       "ct":   "<base64url>",           // ciphertext
//       "tag":  "<base64url>"            // 16-byte GCM auth tag
//     }
//
// Stored as a JSON column in Postgres. The whole envelope round-trips
// through Prisma as a `Json` type. Plaintext is never stored.
//
// Crypto-shred (single record): overwrite the entire envelope column
// with `NULL`. Without `wDek`, the field cipher is unrecoverable.
// We expose `shredEnvelope()` to make the intent explicit at call
// sites — `column = NULL` is too easy to do by accident.
//
// Versioning: bumping `v` requires both an encrypt-time path (writes
// new envelopes in the new format) and a decrypt-time path (handles
// both versions until the historical ones are rotated). We pin the
// current version here. Today only v1 is defined.

import { envelopeMalformedError } from "./errors.js";

export const ENVELOPE_VERSION = 1 as const;

export interface CiphertextEnvelope {
  readonly v: 1;
  readonly alg: "AES-256-GCM";
  /** KEK identifier — opaque from this package's perspective. */
  readonly kek: string;
  /** KEK-wrapped DEK, base64url. */
  readonly wDek: string;
  /** Field-cipher IV, base64url. */
  readonly iv: string;
  /** Ciphertext, base64url. */
  readonly ct: string;
  /** GCM auth tag, base64url. */
  readonly tag: string;
}

/**
 * Parses an untrusted JSON value (e.g. straight from a Prisma `Json`
 * column) into a typed `CiphertextEnvelope`. Throws
 * `ValidationError(ENVELOPE_MALFORMED)` on any structural issue.
 *
 * This is the choke point that prevents a malformed envelope from
 * reaching the decrypt path — `decryptField` always parses through
 * this function so an attacker who can plant a JSON value cannot
 * crash the cipher with a buffer-shape attack.
 */
export function parseEnvelope(value: unknown): CiphertextEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw envelopeMalformedError({ reason: "expected JSON object" });
  }
  const v = value as Record<string, unknown>;

  if (v["v"] !== ENVELOPE_VERSION) {
    throw envelopeMalformedError({
      reason: `unsupported version ${String(v["v"])}; expected ${ENVELOPE_VERSION}`,
    });
  }
  if (v["alg"] !== "AES-256-GCM") {
    throw envelopeMalformedError({ reason: `unsupported alg ${String(v["alg"])}` });
  }
  // The KEK id, wrapped DEK, IV, and auth tag must always carry
  // bytes — an empty value means the envelope is corrupt or
  // truncated. The ciphertext (`ct`) is allowed to be the empty
  // string because AES-GCM legitimately produces a zero-byte
  // ciphertext for a zero-byte plaintext (e.g. an empty
  // "address_line_2" PHI field). In that case the tag still
  // authenticates the binding via AAD, so the envelope is
  // well-formed.
  for (const field of ["kek", "wDek", "iv", "tag"] as const) {
    if (typeof v[field] !== "string" || (v[field] as string).length === 0) {
      throw envelopeMalformedError({ reason: `missing or empty field "${field}"` });
    }
  }
  if (typeof v["ct"] !== "string") {
    throw envelopeMalformedError({ reason: `missing or non-string field "ct"` });
  }

  return {
    v: ENVELOPE_VERSION,
    alg: "AES-256-GCM",
    kek: v["kek"] as string,
    wDek: v["wDek"] as string,
    iv: v["iv"] as string,
    ct: v["ct"] as string,
    tag: v["tag"] as string,
  };
}

/**
 * Serializes an envelope to the wire shape (a plain object suitable
 * for Prisma's `Json` column). Provided as a function so a future
 * format change (e.g. binary CBOR) has a single point to update.
 */
export function serializeEnvelope(env: CiphertextEnvelope): Readonly<Record<string, unknown>> {
  return Object.freeze({
    v: env.v,
    alg: env.alg,
    kek: env.kek,
    wDek: env.wDek,
    iv: env.iv,
    ct: env.ct,
    tag: env.tag,
  });
}

/** Type guard. Useful for runtime narrowing without throwing. */
export function isEnvelope(value: unknown): value is CiphertextEnvelope {
  try {
    parseEnvelope(value);
    return true;
  } catch {
    return false;
  }
}
