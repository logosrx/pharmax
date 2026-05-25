// Cross-tenant claim of UPS shipments due for tracking poll.
//
// Mirrors `claim-active-fedex-shipments.ts` — same selection rules,
// same read-only contract (the UPS poller's dispatch dedupes via
// `RecordShipmentTrackingEvent`'s `(organizationId, source,
// externalEventId)` unique constraint):
//   - `carrier = 'UPS'`
//   - `status NOT IN (DELIVERED, EXCEPTION, RETURN_TO_SENDER, FAILED_DELIVERY)`
//   - `externalTrackerId IS NULL` (shipments with a tracker id were
//     purchased via EasyPost and get webhook updates already)
//   - `lastTrackingEventAt IS NULL OR < NOW - staleThresholdMs`

import type { PrismaClient } from "@pharmax/database";

export interface ActiveUpsShipmentRow {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string;
  readonly trackingNumber: string;
  readonly lastTrackingEventAt: Date | null;
}

export interface ClaimActiveUpsShipmentsOptions {
  readonly batchSize: number;
  readonly staleThresholdMs: number;
}

export type UpsShipmentClaimClient = Pick<PrismaClient, "$queryRaw">;

interface RawRow {
  id: string;
  organizationId: string;
  siteId: string;
  trackingNumber: string;
  lastTrackingEventAt: Date | null;
}

export async function claimActiveUpsShipments(
  client: UpsShipmentClaimClient,
  options: ClaimActiveUpsShipmentsOptions
): Promise<ActiveUpsShipmentRow[]> {
  const { batchSize, staleThresholdMs } = options;

  const rows = await client.$queryRaw<RawRow[]>`
    SELECT
      id,
      "organizationId",
      "siteId",
      "trackingNumber",
      "lastTrackingEventAt"
    FROM "shipment"
    WHERE "carrier" = 'UPS'
      AND "status" NOT IN ('DELIVERED', 'EXCEPTION', 'RETURN_TO_SENDER', 'FAILED_DELIVERY')
      AND "externalTrackerId" IS NULL
      AND (
        "lastTrackingEventAt" IS NULL
        OR "lastTrackingEventAt" < NOW() - (${staleThresholdMs} || ' milliseconds')::interval
      )
    ORDER BY COALESCE("lastTrackingEventAt", "createdAt") ASC
    LIMIT ${batchSize}
  `;

  return rows.map((row) =>
    Object.freeze({
      id: row.id,
      organizationId: row.organizationId,
      siteId: row.siteId,
      trackingNumber: row.trackingNumber,
      lastTrackingEventAt: row.lastTrackingEventAt,
    })
  );
}
