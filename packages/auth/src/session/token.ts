// Opaque session token primitives (pure, no I/O).
//
// A session token is high-entropy random bytes, base64url-encoded, given
// to the client cookie exactly once. Only its SHA-256 hash is persisted
// (`auth_session.tokenHash`), so a read of the session table yields no
// usable tokens — a database-only compromise cannot resume sessions.
//
// SHA-256 (not Argon2) is correct here: the input is already 256 bits of
// uniform randomness, so there is nothing to brute-force and no benefit
// to a slow KDF. The hash exists only to avoid storing the bearer token
// verbatim. Lookups are a single indexed, constant-work equality on the
// hash.

import { createHash, randomBytes } from "node:crypto";

/** Minimum token entropy. 32 bytes = 256 bits. */
export const MIN_SESSION_TOKEN_BYTES = 32;

/**
 * Mint a fresh opaque session token. `byteLength` comes from
 * `SessionPolicy.tokenBytes`; values below 256 bits are clamped up so a
 * misconfiguration can never weaken the token below the floor.
 */
export function mintSessionToken(byteLength: number): string {
  const bytes = Number.isFinite(byteLength)
    ? Math.max(byteLength, MIN_SESSION_TOKEN_BYTES)
    : MIN_SESSION_TOKEN_BYTES;
  return randomBytes(bytes).toString("base64url");
}

/**
 * Deterministic storage hash of a raw token. Same input → same hex
 * digest, enabling the unique-index lookup on `tokenHash`.
 */
export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}
