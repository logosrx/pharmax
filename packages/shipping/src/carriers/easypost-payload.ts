// Zod schema for the EasyPost webhook payloads we actually consume.
//
// EasyPost's webhook bodies are large and event-typed. We only need a
// handful of fields to ingest a tracker update:
//
//   description: "tracker.updated" | "tracker.created" | ...
//   result.id:               unique tracker event id (idempotency key)
//   result.tracking_code:    carrier tracking number
//   result.status:           normalized lifecycle status
//   result.status_detail:    optional sub-status
//   result.updated_at:       ISO timestamp the tracker was last updated
//
// We parse with a tolerant schema that accepts extra fields so future
// EasyPost additions don't break ingestion.

import { z } from "zod";

export const EASYPOST_TRACKER_EVENT_DESCRIPTIONS = ["tracker.created", "tracker.updated"] as const;

export type EasyPostTrackerEventDescription = (typeof EASYPOST_TRACKER_EVENT_DESCRIPTIONS)[number];

const trackerResultSchema = z
  .object({
    id: z.string().min(1).max(128),
    tracking_code: z.string().min(1).max(128),
    status: z.string().min(1).max(64),
    status_detail: z.string().max(128).nullish(),
    updated_at: z.string().min(1),
    carrier: z.string().min(1).max(64).optional(),
  })
  .passthrough();

export const easyPostTrackerWebhookSchema = z
  .object({
    id: z.string().min(1).max(128),
    description: z.enum(EASYPOST_TRACKER_EVENT_DESCRIPTIONS),
    result: trackerResultSchema,
  })
  .passthrough();

export type EasyPostTrackerWebhookPayload = z.infer<typeof easyPostTrackerWebhookSchema>;

export class EasyPostPayloadError extends Error {
  constructor(reason: string) {
    super(`EasyPost webhook payload error: ${reason}`);
    this.name = "EasyPostPayloadError";
  }
}

/**
 * Parse an EasyPost webhook body. Returns `null` if the event type is
 * not a tracker event we ingest (caller should ACK with 200 but skip).
 *
 * Throws `EasyPostPayloadError` if the payload is malformed.
 */
export function parseEasyPostTrackerWebhook(
  rawJson: unknown
): EasyPostTrackerWebhookPayload | null {
  if (typeof rawJson !== "object" || rawJson === null) {
    throw new EasyPostPayloadError("Webhook body must be a JSON object.");
  }
  const description = (rawJson as { description?: unknown }).description;
  if (
    typeof description !== "string" ||
    !(EASYPOST_TRACKER_EVENT_DESCRIPTIONS as ReadonlyArray<string>).includes(description)
  ) {
    return null;
  }
  const parsed = easyPostTrackerWebhookSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new EasyPostPayloadError(parsed.error.message);
  }
  return parsed.data;
}

/**
 * Project a parsed tracker webhook down to the PHI-FREE subset we
 * persist and replay.
 *
 * The parse schema above is intentionally tolerant (`.passthrough()`)
 * so a new EasyPost field never breaks ingestion. But that tolerance
 * means recipient name / address (PHI by linkage) on the inbound body
 * would otherwise be carried verbatim into
 * `easypost_webhook_event.payload` and stored at rest in an
 * RLS-exempt ledger table, outside the envelope-encryption scheme.
 *
 * The worker only ever reads `id`, `description`, and
 * `result.{id, tracking_code, status, status_detail, updated_at,
 * carrier}` (see process-easypost-webhook-event.ts). We store EXACTLY
 * those, so no recipient PHI is ever written to the row. Apply this
 * at the ingestion choke point (handle-easypost-webhook) before
 * `recordReceived`, so every store implementation and the downstream
 * `rawPayload` see only the minimized shape.
 */
export function projectTrackerEventForStorage(
  payload: EasyPostTrackerWebhookPayload
): EasyPostTrackerWebhookPayload {
  return {
    id: payload.id,
    description: payload.description,
    result: {
      id: payload.result.id,
      tracking_code: payload.result.tracking_code,
      status: payload.result.status,
      ...(typeof payload.result.status_detail === "string"
        ? { status_detail: payload.result.status_detail }
        : {}),
      updated_at: payload.result.updated_at,
      ...(typeof payload.result.carrier === "string" ? { carrier: payload.result.carrier } : {}),
    },
  };
}
