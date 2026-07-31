// Single webhook delivery attempt (ADR-0032).
//
// Pure transport: given a decrypted signing secret and a delivery
// row's fields, POST the signed envelope to the partner endpoint and
// classify the outcome. Retry/backoff/DEAD bookkeeping belongs to
// the worker drain, not here.
//
// Envelope shape (documented in openapi-v1.yaml):
//
//   {
//     "id":         "<webhook_delivery id>",   // partner-side dedupe key
//     "type":       "order.shipped.v1",
//     "occurredAt": "<ISO-8601>",
//     "data":       { ...registry-validated payload }
//   }
//
// PHI: payloads are phi-safe by construction; errors captured here
// include the HTTP status and a short message, never response bodies
// (a partner's error page could echo anything).

import { signWebhookPayload, WEBHOOK_SIGNATURE_HEADER } from "./signature.js";

export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
export const WEBHOOK_USER_AGENT = "Pharmax-Webhooks/1.0";

export interface AttemptWebhookDeliveryInput {
  readonly url: string;
  /** Decrypted `pxw_` signing secret. */
  readonly secret: string;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly payload: unknown;
  /** When the source event was recorded (outbox createdAt). */
  readonly occurredAt: Date;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Injectable clock (unix ms) for deterministic signatures in tests. */
  readonly nowMs?: number;
}

export type AttemptWebhookDeliveryResult =
  | { readonly ok: true; readonly responseStatus: number }
  | { readonly ok: false; readonly responseStatus: number | null; readonly error: string };

export async function attemptWebhookDelivery(
  input: AttemptWebhookDeliveryInput
): Promise<AttemptWebhookDeliveryResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? WEBHOOK_DELIVERY_TIMEOUT_MS;
  const nowMs = input.nowMs ?? Date.now();

  const body = JSON.stringify({
    id: input.deliveryId,
    type: input.eventType,
    occurredAt: input.occurredAt.toISOString(),
    data: input.payload,
  });

  const signature = signWebhookPayload({
    secret: input.secret,
    timestamp: Math.floor(nowMs / 1000),
    body,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": WEBHOOK_USER_AGENT,
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        "pharmax-event-type": input.eventType,
        "pharmax-delivery-id": input.deliveryId,
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });

    if (response.status >= 200 && response.status < 300) {
      return Object.freeze({ ok: true, responseStatus: response.status });
    }
    return Object.freeze({
      ok: false,
      responseStatus: response.status,
      error: `Endpoint responded ${response.status}`,
    });
  } catch (cause) {
    const message =
      cause instanceof Error && cause.name === "AbortError"
        ? `Timed out after ${timeoutMs}ms`
        : cause instanceof Error
          ? `${cause.name}: ${cause.message}`
          : "Unknown transport error";
    return Object.freeze({ ok: false, responseStatus: null, error: message });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decrypt binding for a subscription's signing secret — kept next to
 * the transport so the worker and any future rotation command agree
 * on the AAD tuple by importing ONE constant.
 */
export function webhookSecretBinding(input: {
  readonly organizationId: string;
  readonly subscriptionId: string;
}): {
  readonly tenantId: string;
  readonly table: "webhook_subscription";
  readonly column: "secret";
  readonly recordId: string;
} {
  return Object.freeze({
    tenantId: input.organizationId,
    table: "webhook_subscription" as const,
    column: "secret" as const,
    recordId: input.subscriptionId,
  });
}
