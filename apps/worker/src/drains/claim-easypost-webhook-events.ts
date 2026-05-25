// Atomic batch claim of `easypost_webhook_event` rows for processing.
//
// Mirrors the Stripe claim (see `claim-stripe-webhook-events.ts`).
// The query below is the canonical "transactional outbox claim"
// pattern adapted for the EasyPost webhook ledger:
//
//   UPDATE easypost_webhook_event
//   SET    status = 'PROCESSING',
//          processing_started_at = NOW(),
//          attempts = attempts + 1,
//          next_attempt_at = NOW() + lease
//   WHERE  id IN (
//     SELECT id FROM easypost_webhook_event
//     WHERE status IN ('PENDING','FAILED')
//       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
//     ORDER BY received_at
//     LIMIT $batch
//     FOR UPDATE SKIP LOCKED
//   )
//   RETURNING *;
//
// Postgres holds row-level locks from the inner SELECT through the
// parent UPDATE in the same implicit transaction. Other workers
// trying the same query are blocked by FOR UPDATE — which they then
// SKIP LOCKED past, picking different rows. The status flip
// (PENDING/FAILED → PROCESSING) prevents any subsequent SELECT from
// re-selecting the row. The next_attempt_at lease is a belt-and-
// suspenders safety net for a future reaper if status flips ever race.
//
// We INCREMENT attempts here because the worker delegates dispatch to
// `executeEasyPostWebhookEventDispatch`, which expects a record whose
// `attempts` counter has ALREADY been bumped by the caller (same
// contract as the Stripe pipeline).

import type { EasyPostWebhookEvent, PrismaClient } from "@pharmax/database";

import type { ClaimedEasyPostWebhookEventRow } from "./row-types.js";

export interface ClaimEasyPostWebhookEventsOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
}

export type EasyPostWebhookClaimClient = Pick<PrismaClient, "$queryRaw">;

export async function claimEasyPostWebhookEvents(
  client: EasyPostWebhookClaimClient,
  options: ClaimEasyPostWebhookEventsOptions
): Promise<ClaimedEasyPostWebhookEventRow[]> {
  const { batchSize, leaseMs } = options;

  const rows = await client.$queryRaw<EasyPostWebhookEvent[]>`
    UPDATE "easypost_webhook_event"
    SET    "status" = 'PROCESSING',
           "processingStartedAt" = NOW(),
           "attempts" = "easypost_webhook_event"."attempts" + 1,
           "nextAttemptAt" = NOW() + (${leaseMs} || ' milliseconds')::interval
    WHERE  "id" IN (
      SELECT "id" FROM "easypost_webhook_event"
      WHERE "status" IN ('PENDING','FAILED')
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
      ORDER BY "receivedAt"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;

  return rows.map(toClaimedRow);
}

function toClaimedRow(row: EasyPostWebhookEvent): ClaimedEasyPostWebhookEventRow {
  return Object.freeze({
    id: row.id,
    externalEventId: row.externalEventId,
    eventType: row.eventType,
    trackingCode: row.trackingCode,
    carrierStatus: row.carrierStatus,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    receivedAt: row.receivedAt,
    signatureVerifiedAt: row.signatureVerifiedAt,
    processingStartedAt: row.processingStartedAt,
    processedAt: row.processedAt,
    nextAttemptAt: row.nextAttemptAt,
  });
}
