// Atomic batch claim of `webhook_delivery` rows (ADR-0032).
//
// Same lease pattern as `claim-outbox-events`: bump `attempts` (the
// fence token) and push `nextAttemptAt` to NOW + leaseMs so other
// workers skip the row while this one is delivering. Status stays
// PENDING/FAILED during the attempt; the drainer's fenced completion
// write decides SENT / FAILED / DEAD.
//
// The worker connects as `pharmax_system` (BYPASSRLS), so the raw
// UPDATE sees every org's rows — deliveries are inherently a
// cross-tenant work queue, same as the outbox itself.

import type { PrismaClient, WebhookDelivery } from "@pharmax/database";

export interface ClaimWebhookDeliveriesOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
}

export type WebhookDeliveryClaimClient = Pick<PrismaClient, "$queryRaw">;

export interface ClaimedWebhookDeliveryRow {
  readonly id: string;
  readonly organizationId: string;
  readonly subscriptionId: string;
  readonly outboxEventId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly status: WebhookDelivery["status"];
  readonly attempts: number;
  /** Fan-out's persisted W3C trace context; null for pre-trace rows. */
  readonly traceparent: string | null;
  readonly createdAt: Date;
}

export async function claimWebhookDeliveries(
  client: WebhookDeliveryClaimClient,
  options: ClaimWebhookDeliveriesOptions
): Promise<ClaimedWebhookDeliveryRow[]> {
  const { batchSize, leaseMs } = options;

  const rows = await client.$queryRaw<WebhookDelivery[]>`
    UPDATE "webhook_delivery"
    SET    "attempts" = "webhook_delivery"."attempts" + 1,
           "nextAttemptAt" = NOW() + (${leaseMs} || ' milliseconds')::interval
    WHERE  "id" IN (
      SELECT "id" FROM "webhook_delivery"
      WHERE "status" IN ('PENDING','FAILED')
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
      ORDER BY "createdAt"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;

  return rows.map((row) =>
    Object.freeze({
      id: row.id,
      organizationId: row.organizationId,
      subscriptionId: row.subscriptionId,
      outboxEventId: row.outboxEventId,
      eventType: row.eventType,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      traceparent: row.traceparent,
      createdAt: row.createdAt,
    })
  );
}
