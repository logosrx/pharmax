// Partner API key token primitives (ADR-0032).
//
// Token shape: `pxk_` + 32 random bytes, base64url (43 chars, no
// padding). ~256 bits of entropy — brute-forcing the SHA-256 hash
// index is not a realistic attack, so no per-token salt is needed
// (same reasoning as the session engine's opaque token).
//
// The raw token is generated at the TRANSPORT layer (the mint route)
// and returned to the caller exactly once. Only the SHA-256 hex hash
// crosses into the command bus, so neither `command_log` nor the
// idempotency response cache can ever leak the secret.
//
// PHI: none.

import { createHash, randomBytes } from "node:crypto";

export const API_KEY_TOKEN_PREFIX = "pxk_";
export const WEBHOOK_SECRET_PREFIX = "pxw_";

/** 32 bytes base64url → 43 chars, no padding. */
const TOKEN_BODY_LENGTH = 43;

const API_KEY_TOKEN_REGEX = /^pxk_[A-Za-z0-9_-]{43}$/;

export interface GeneratedApiKeyToken {
  /** The raw bearer token. Show once; never store. */
  readonly token: string;
  /** SHA-256 (hex) of the raw token — the at-rest lookup key. */
  readonly tokenHash: string;
  /** Display prefix (e.g. `pxk_3fA9`) for operator-facing key lists. */
  readonly tokenPrefix: string;
}

export function generateApiKeyToken(): GeneratedApiKeyToken {
  const body = randomBytes(32).toString("base64url");
  const token = `${API_KEY_TOKEN_PREFIX}${body}`;
  return Object.freeze({
    token,
    tokenHash: hashApiKeyToken(token),
    tokenPrefix: token.slice(0, API_KEY_TOKEN_PREFIX.length + 4),
  });
}

/** SHA-256 hex digest of the raw token. Deterministic — the DB lookup key. */
export function hashApiKeyToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Cheap shape check BEFORE any DB work. Rejecting malformed bearer
 * values here keeps garbage requests off the `api_key` index.
 */
export function isWellFormedApiKeyToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === API_KEY_TOKEN_PREFIX.length + TOKEN_BODY_LENGTH &&
    API_KEY_TOKEN_REGEX.test(value)
  );
}

/**
 * Webhook signing secret: `pxw_` + 32 random bytes base64url.
 * Generated at the transport layer (like the API key token), passed
 * into `CreateWebhookSubscription` as a redacted input field, and
 * stored only as a `@pharmax/crypto` ciphertext envelope.
 */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}
