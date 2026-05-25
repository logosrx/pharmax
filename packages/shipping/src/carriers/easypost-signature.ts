// EasyPost webhook signature verification.
//
// EasyPost signs webhook payloads with HMAC-SHA256 over the raw
// request body, keyed by the secret configured on the webhook in
// the EasyPost dashboard. The signature is sent in the
// `X-Hmac-Signature` header as a lowercase hex string prefixed with
// `hmac-sha256-hex=`.
//
// Reference: https://docs.easypost.com/docs/webhooks#webhook-signatures
//
// Implementation notes:
//   - We compare using `crypto.timingSafeEqual` to avoid leaking
//     information through string-compare timing.
//   - The raw body MUST be the exact bytes received over the wire.
//     Any whitespace change, JSON.parse-then-stringify, or content
//     encoding will produce a different HMAC and the signature will
//     fail.
//   - Like Stripe, the verifier returns a typed result instead of
//     throwing so callers can branch on outcome without try/catch
//     around untyped errors.

import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "hmac-sha256-hex=";

export class EasyPostSignatureError extends Error {
  constructor(reason: string) {
    super(`EasyPost webhook signature verification failed: ${reason}`);
    this.name = "EasyPostSignatureError";
  }
}

export class EasyPostWebhookConfigError extends Error {
  constructor(reason: string) {
    super(`EasyPost webhook configuration error: ${reason}`);
    this.name = "EasyPostWebhookConfigError";
  }
}

export interface VerifyEasyPostSignatureInput {
  readonly rawBody: string | Buffer;
  readonly signatureHeader: string;
  readonly webhookSecret: string;
}

export type EasyPostSignatureVerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: EasyPostSignatureError };

function expectedSignatureHex(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function constantTimeEqualHex(expectedHex: string, providedHex: string): boolean {
  if (expectedHex.length !== providedHex.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(providedHex, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify an EasyPost webhook signature. Returns a typed result so the
 * caller can respond 401/403 without leaking error internals.
 *
 * Throws `EasyPostWebhookConfigError` only for misconfiguration
 * (missing secret), which is a programmer error, not a runtime
 * security boundary.
 */
export function verifyEasyPostSignature(
  input: VerifyEasyPostSignatureInput
): EasyPostSignatureVerificationResult {
  if (input.webhookSecret.length === 0) {
    throw new EasyPostWebhookConfigError("EasyPost webhook secret is not configured.");
  }
  if (input.signatureHeader.length === 0) {
    return { ok: false, error: new EasyPostSignatureError("Missing X-Hmac-Signature header.") };
  }

  const lower = input.signatureHeader.trim().toLowerCase();
  const providedHex = lower.startsWith(SIGNATURE_PREFIX)
    ? lower.slice(SIGNATURE_PREFIX.length)
    : lower;

  if (!/^[0-9a-f]+$/.test(providedHex)) {
    return {
      ok: false,
      error: new EasyPostSignatureError("Signature is not a hex string."),
    };
  }

  const bodyBuffer =
    typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody;
  const expected = expectedSignatureHex(input.webhookSecret, bodyBuffer);

  if (!constantTimeEqualHex(expected, providedHex)) {
    return { ok: false, error: new EasyPostSignatureError("HMAC-SHA256 mismatch.") };
  }
  return { ok: true };
}
