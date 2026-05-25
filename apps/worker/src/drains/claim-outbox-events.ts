// Atomic batch claim of `event_outbox` rows.
//
// Same pattern as the Stripe webhook claim, with two differences:
//
//   1. The outbox status enum has no PROCESSING state. Concurrent
//      workers must not pick the same row, but a flip to DISPATCHED
//      would prematurely declare success. Instead we LEASE the row by
//      bumping `next_attempt_at` to NOW + leaseMs. Other workers'
//      claim queries filter `next_attempt_at IS NULL OR <= NOW()` so
//      a leased row is invisible to them until the lease expires.
//      Status stays PENDING during processing.
//
//   2. The selection ALSO includes status='FAILED' rows whose lease has
//      passed — these are retries waiting on backoff.
//
// If the worker crashes mid-process, the lease will eventually expire
// and another worker (or the same one after restart) will retry the
// row. attempts is incremented during the claim so retry math is
// honest about how many attempts have happened.

import type { PrismaClient, EventOutbox } from "@pharmax/database";

import type { ClaimedOutboxEventRow } from "./row-types.js";

export interface ClaimOutboxEventsOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
}

export type OutboxClaimClient = Pick<PrismaClient, "$queryRaw">;

export async function claimOutboxEvents(
  client: OutboxClaimClient,
  options: ClaimOutboxEventsOptions
): Promise<ClaimedOutboxEventRow[]> {
  const { batchSize, leaseMs } = options;

  const rows = await client.$queryRaw<EventOutbox[]>`
    UPDATE "event_outbox"
    SET    "attempts" = "event_outbox"."attempts" + 1,
           "nextAttemptAt" = NOW() + (${leaseMs} || ' milliseconds')::interval
    WHERE  "id" IN (
      SELECT "id" FROM "event_outbox"
      WHERE "status" IN ('PENDING','FAILED')
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
      ORDER BY "createdAt"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;

  return rows.map(toClaimedRow);
}

function toClaimedRow(row: EventOutbox): ClaimedOutboxEventRow {
  return Object.freeze({
    id: row.id,
    organizationId: row.organizationId,
    eventType: row.eventType,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
    dispatchedAt: row.dispatchedAt,
    createdAt: row.createdAt,
  });
}
