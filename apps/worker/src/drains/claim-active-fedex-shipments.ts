// Cross-tenant claim of FedEx shipments due for tracking poll.
//
// Selection rules (all AND):
//   - `carrier = 'FEDEX'` (the only carrier the FedEx adapter can poll)
//   - `status <> 'DELIVERED'` — delivery is the ONLY poll-terminal
//     state. EXCEPTION / RETURN_TO_SENDER / FAILED_DELIVERY packages
//     are still moving through the carrier network (a weather delay
//     resolves back to in-transit; an RTS package travels all the
//     way back to the pharmacy; a failed delivery gets reattempted).
//     Going dark on exactly the packages an operator most needs to
//     watch was the old behavior's visibility gap.
//   - `createdAt > NOW - maxShipmentAgeDays` — the age horizon that
//     replaces status-based termination as the "stop polling
//     eventually" guarantee, so a never-delivered zombie shipment
//     doesn't consume Track API quota forever.
//   - `externalTrackerId IS NULL` — shipments with a tracker id were
//     purchased via EasyPost (which provides webhook tracking already);
//     we don't want to double-track those
//   - `lastTrackingEventAt IS NULL OR lastTrackingEventAt < NOW - staleThresholdMs`
//     to throttle re-polling. EONPRO uses 2h; we default to the same.
//
// Cross-tenant scope: the worker drain runs in system context, reads
// across orgs in one SQL pass, then the dispatcher loops per-org to
// enter tenancy + call the command bus. The drainer is the legitimate
// system-context bridge (see eslint Override 3b).

import type { PrismaClient } from "@pharmax/database";

export interface ActiveFedExShipmentRow {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string;
  readonly trackingNumber: string;
  readonly lastTrackingEventAt: Date | null;
}

export interface ClaimActiveFedExShipmentsOptions {
  readonly batchSize: number;
  readonly staleThresholdMs: number;
  /**
   * Stop polling shipments older than this many days regardless of
   * status — the bound that keeps non-DELIVERED zombies from being
   * polled forever.
   */
  readonly maxShipmentAgeDays: number;
}

export type FedExShipmentClaimClient = Pick<PrismaClient, "$queryRaw">;

interface RawRow {
  id: string;
  organizationId: string;
  siteId: string;
  trackingNumber: string;
  lastTrackingEventAt: Date | null;
}

export async function claimActiveFedExShipments(
  client: FedExShipmentClaimClient,
  options: ClaimActiveFedExShipmentsOptions
): Promise<ActiveFedExShipmentRow[]> {
  const { batchSize, staleThresholdMs, maxShipmentAgeDays } = options;

  // Note: no FOR UPDATE here — polling is a read-only operation
  // from the database's point of view; the dispatcher uses the
  // command bus's own idempotency (RecordShipmentTrackingEvent is
  // keyed on `(organizationId, source, externalEventId)`) to handle
  // concurrent workers picking the same tracking number.
  const rows = await client.$queryRaw<RawRow[]>`
    SELECT
      id,
      "organizationId",
      "siteId",
      "trackingNumber",
      "lastTrackingEventAt"
    FROM "shipment"
    WHERE "carrier" = 'FEDEX'
      AND "status" <> 'DELIVERED'
      AND "createdAt" > NOW() - (${maxShipmentAgeDays} || ' days')::interval
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
