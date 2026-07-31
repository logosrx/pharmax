// Outbound webhook payload signing (ADR-0032).
//
// Stripe-style scheme so partners can verify with well-known code:
//
//   Pharmax-Signature: t=<unix seconds>,v1=<hex HMAC-SHA-256>
//
// where the MAC is computed over `${t}.${rawBody}` with the
// subscription's `pxw_` secret. Binding the timestamp into the MAC
// (instead of a separate header) makes replay windows verifiable:
// a partner rejecting stale `t` values gets replay protection for
// free.
//
// PHI: none — this module sees only the serialized (phi-safe,
// registry-validated) payload as an opaque string.

import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADER = "Pharmax-Signature";

/** Default verification tolerance partners are documented to use. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

export interface SignWebhookPayloadInput {
  /** The subscription's raw `pxw_` signing secret. */
  readonly secret: string;
  /** Unix timestamp in SECONDS (not ms). */
  readonly timestamp: number;
  /** The exact raw request body string being sent. */
  readonly body: string;
}

export function signWebhookPayload(input: SignWebhookPayloadInput): string {
  const mac = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.body}`, "utf8")
    .digest("hex");
  return `t=${input.timestamp},v1=${mac}`;
}

export interface VerifyWebhookSignatureInput {
  readonly secret: string;
  /** The received `Pharmax-Signature` header value. */
  readonly header: string;
  /** The exact raw request body string as received. */
  readonly body: string;
  /** Reject signatures older/newer than this many seconds. */
  readonly toleranceSeconds?: number;
  /** Injectable clock for tests. Unix SECONDS. */
  readonly nowSeconds?: number;
}

/**
 * Reference verifier — used by our tests and published in the API
 * docs so partners can copy a known-good implementation.
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  const tolerance = input.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  const parts = new Map<string, string>();
  for (const segment of input.header.split(",")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) return false;
    parts.set(segment.slice(0, eq).trim(), segment.slice(eq + 1).trim());
  }

  const rawTimestamp = parts.get("t");
  const receivedMac = parts.get("v1");
  if (rawTimestamp === undefined || receivedMac === undefined) return false;

  const timestamp = Number.parseInt(rawTimestamp, 10);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const expectedMac = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.body}`, "utf8")
    .digest("hex");

  const received = Buffer.from(receivedMac, "utf8");
  const expected = Buffer.from(expectedMac, "utf8");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
