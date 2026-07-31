// FedEx Advanced Integrated Visibility webhook signature verification.
//
// FedEx signs every AIV payload notification with an HMAC keyed by
// the "security token" configured on the webhook project in the
// FedEx Developer Portal. The signature arrives base64-encoded in
// the `fdx-signature` request header; the HMAC is computed over the
// raw request body.
//
// Reference: FedEx Developer Portal — Advanced Integrated Visibility
// webhook FAQ ("FedEx Webhook will send HMAC based base64 encoded
// fdx-signature in the header with every payload notification. You
// can authenticate a payload by generating HMAC signature based on
// payload and security token to compare it with the fdx-signature.")
//
// Implementation notes (same discipline as the EasyPost verifier):
//   - `crypto.timingSafeEqual` for the comparison.
//   - The raw body MUST be the exact bytes received over the wire.
//   - Typed result instead of throwing, so callers branch on outcome.
//   - HMAC-SHA256 is the algorithm FedEx's portal tooling produces.

import { createHmac, timingSafeEqual } from "node:crypto";

export class FedExSignatureError extends Error {
  constructor(reason: string) {
    super(`FedEx webhook signature verification failed: ${reason}`);
    this.name = "FedExSignatureError";
  }
}

export class FedExWebhookConfigError extends Error {
  constructor(reason: string) {
    super(`FedEx webhook configuration error: ${reason}`);
    this.name = "FedExWebhookConfigError";
  }
}

export interface VerifyFedExSignatureInput {
  readonly rawBody: string | Buffer;
  readonly signatureHeader: string;
  /** The webhook project's security token from the FedEx portal. */
  readonly webhookSecret: string;
}

export type FedExSignatureVerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: FedExSignatureError };

function expectedSignature(secret: string, body: Buffer): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/**
 * Verify a FedEx AIV webhook signature. Returns a typed result so
 * the caller can respond 400 without leaking error internals.
 *
 * Throws `FedExWebhookConfigError` only for misconfiguration
 * (missing secret) — a programmer error, not a runtime security
 * boundary.
 */
export function verifyFedExSignature(
  input: VerifyFedExSignatureInput
): FedExSignatureVerificationResult {
  if (input.webhookSecret.length === 0) {
    throw new FedExWebhookConfigError("FedEx webhook secret is not configured.");
  }
  if (input.signatureHeader.length === 0) {
    return { ok: false, error: new FedExSignatureError("Missing fdx-signature header.") };
  }

  let provided: Buffer;
  try {
    provided = Buffer.from(input.signatureHeader.trim(), "base64");
  } catch {
    return { ok: false, error: new FedExSignatureError("Signature is not valid base64.") };
  }
  if (provided.length === 0) {
    return { ok: false, error: new FedExSignatureError("Signature decodes to zero bytes.") };
  }

  const bodyBuffer =
    typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody;
  const expected = expectedSignature(input.webhookSecret, bodyBuffer);

  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, error: new FedExSignatureError("HMAC-SHA256 mismatch.") };
  }
  return { ok: true };
}
