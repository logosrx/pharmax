// Atomic batch claim of `fedex_webhook_event` rows for processing.
//
// Mirrors `claim-easypost-webhook-events.ts` one-for-one: single
// UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) statement
// that flips PENDING/FAILED → PROCESSING, increments attempts, and
// sets a lease so a crash mid-tick doesn't strand the row past the
// lease window. See the EasyPost claim module for the full pattern
// commentary.

import type { FedExWebhookEvent, PrismaClient } from "@pharmax/database";

import type { ClaimedFedExWebhookEventRow } from "./row-types.js";

export interface ClaimFedExWebhookEventsOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
}

export type FedExWebhookClaimClient = Pick<PrismaClient, "$queryRaw">;

export async function claimFedExWebhookEvents(
  client: FedExWebhookClaimClient,
  options: ClaimFedExWebhookEventsOptions
): Promise<ClaimedFedExWebhookEventRow[]> {
  const { batchSize, leaseMs } = options;

  const rows = await client.$queryRaw<FedExWebhookEvent[]>`
    UPDATE "fedex_webhook_event"
    SET    "status" = 'PROCESSING',
           "processingStartedAt" = NOW(),
           "attempts" = "fedex_webhook_event"."attempts" + 1,
           "nextAttemptAt" = NOW() + (${leaseMs} || ' milliseconds')::interval
    WHERE  "id" IN (
      SELECT "id" FROM "fedex_webhook_event"
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

function toClaimedRow(row: FedExWebhookEvent): ClaimedFedExWebhookEventRow {
  return Object.freeze({
    id: row.id,
    externalEventId: row.externalEventId,
    eventType: row.eventType,
    trackingNumber: row.trackingNumber,
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
