// Atomic batch claim of `stripe_webhook_event` rows for processing.
//
// The query below is the canonical "transactional outbox claim"
// pattern adapted for the Stripe webhook ledger:
//
//   UPDATE stripe_webhook_event
//   SET    status = 'PROCESSING',
//          processing_started_at = NOW(),
//          attempts = attempts + 1,
//          next_attempt_at = NOW() + lease
//   WHERE  id IN (
//     SELECT id FROM stripe_webhook_event
//     WHERE status IN ('PENDING','FAILED')
//       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
//     ORDER BY received_at
//     LIMIT $batch
//     FOR UPDATE SKIP LOCKED
//   )
//   RETURNING *;
//
// Why a single statement:
//   - Postgres holds row-level locks from the inner SELECT through the
//     parent UPDATE in the same implicit transaction. Other workers
//     trying the same query are blocked by FOR UPDATE — which they then
//     SKIP LOCKED past, picking different rows.
//   - The status flip (PENDING/FAILED -> PROCESSING) prevents any
//     subsequent SELECT (after this transaction commits) from re-
//     selecting the row. The next_attempt_at lease is a belt-and-
//     suspenders safety net for a future reaper if status flips ever
//     race.
//
// Why we INCREMENT attempts here:
//   - The worker delegates dispatch to platform-core's
//     `executeStripeWebhookEventDispatch`, which expects a record whose
//     `attempts` counter has ALREADY been bumped by the caller (see
//     `process-stripe-webhook-event.ts` for the contract). Incrementing
//     here means downstream backoff math reads the right number.
//
// FAILED rows are also eligible because retry-after-backoff is an
// expected steady state. The next_attempt_at filter gates them.

import type { PrismaClient, StripeWebhookEvent } from "@pharmax/database";

import type { ClaimedStripeWebhookEventRow } from "./row-types.js";

export interface ClaimStripeWebhookEventsOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
}

export type StripeWebhookClaimClient = Pick<PrismaClient, "$queryRaw">;

export async function claimStripeWebhookEvents(
  client: StripeWebhookClaimClient,
  options: ClaimStripeWebhookEventsOptions
): Promise<ClaimedStripeWebhookEventRow[]> {
  const { batchSize, leaseMs } = options;

  // `Prisma.sql` template literal automatically parameterizes values to
  // prevent injection. We use $queryRaw (not $queryRawUnsafe) so the
  // batchSize and leaseMs land as bound parameters.
  const rows = await client.$queryRaw<StripeWebhookEvent[]>`
    UPDATE "stripe_webhook_event"
    SET    "status" = 'PROCESSING',
           "processingStartedAt" = NOW(),
           "attempts" = "stripe_webhook_event"."attempts" + 1,
           "nextAttemptAt" = NOW() + (${leaseMs} || ' milliseconds')::interval
    WHERE  "id" IN (
      SELECT "id" FROM "stripe_webhook_event"
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

function toClaimedRow(row: StripeWebhookEvent): ClaimedStripeWebhookEventRow {
  return Object.freeze({
    id: row.id,
    stripeEventId: row.stripeEventId,
    eventType: row.eventType,
    apiVersion: row.apiVersion,
    livemode: row.livemode,
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
