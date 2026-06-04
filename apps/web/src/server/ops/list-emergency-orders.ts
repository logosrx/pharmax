// Read-only query helper for the EMERGENCY-bucket operator queue.
//
// Lives in `apps/web` (not `@pharmax/orders`) because it's a
// UI-facing projection — the shape returns presentation-ready fields
// (order display id, escalation reason from the most-recent
// shipment tracking event, time-since-escalation) rather than the
// raw domain entity. If a second consumer (CLI, reporting) needs
// the same data, the projection moves to a shared package; for now
// a single consumer keeps the abstraction cost down.
//
// Tenancy:
//   - Caller MUST have resolved a TenancyContext before calling
//     this. The query relies on the Prisma tenancy extension to
//     auto-scope by `organizationId`; we ALSO pass the explicit
//     predicate as defense in depth.
//
// PHI:
//   - Returns non-PHI columns only (order id, status, bucket move
//     timestamps, tracking-event metadata). No patient names,
//     no addresses, no prescription details.

import "server-only";

import { readInOrgScope } from "@pharmax/database";

const EMERGENCY_BUCKET_CODE = "EMERGENCY";

export interface EmergencyQueueRow {
  readonly orderId: string;
  readonly externalOrderNumber: string | null;
  readonly currentStatus: string;
  readonly priority: string;
  readonly receivedAt: Date;
  /** When the order was moved into the EMERGENCY bucket (defaults to `updatedAt`). */
  readonly enteredEmergencyAt: Date;
  readonly clinicId: string;
  readonly siteId: string;
  /** End-to-end SLA deadline (null for pre-SLA-wiring orders). Drives
   *  the SLA badge + the "escalated for SLA breach" reason hint. */
  readonly slaDeadlineAt: Date | null;
  /** Latest carrier tracking event tied to a shipment for this order, if any. */
  readonly latestShipmentEvent: {
    readonly kind: string;
    readonly carrierStatus: string;
    readonly occurredAt: Date;
    readonly shipmentId: string;
  } | null;
  readonly version: number;
}

export interface ListEmergencyOrdersResult {
  readonly bucketExists: boolean;
  readonly rows: ReadonlyArray<EmergencyQueueRow>;
}

export async function listEmergencyOrders(input: {
  readonly organizationId: string;
  /** Cap returned rows; default 100 (operators rarely have more queued). */
  readonly limit?: number;
}): Promise<ListEmergencyOrdersResult> {
  const limit = input.limit ?? 100;

  return readInOrgScope(input.organizationId, async (tx) => {
    const bucket = await tx.bucket.findUnique({
      where: {
        organizationId_code: {
          organizationId: input.organizationId,
          code: EMERGENCY_BUCKET_CODE,
        },
      },
      select: { id: true },
    });
    if (bucket === null) {
      return Object.freeze({ bucketExists: false, rows: [] });
    }

    const orders = await tx.order.findMany({
      where: {
        organizationId: input.organizationId,
        currentBucketId: bucket.id,
      },
      select: {
        id: true,
        externalOrderNumber: true,
        currentStatus: true,
        priority: true,
        receivedAt: true,
        updatedAt: true,
        clinicId: true,
        siteId: true,
        version: true,
        slaDeadlineAt: true,
        shipments: {
          select: {
            id: true,
            trackingEvents: {
              select: {
                kind: true,
                carrierStatus: true,
                occurredAt: true,
              },
              orderBy: { occurredAt: "desc" },
              take: 1,
            },
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: [{ priority: "desc" }, { receivedAt: "asc" }],
      take: limit,
    });

    const rows: EmergencyQueueRow[] = orders.map((o) => {
      const latestShipment = o.shipments[0];
      const latestEvent = latestShipment?.trackingEvents[0];
      return Object.freeze({
        orderId: o.id,
        externalOrderNumber: o.externalOrderNumber,
        currentStatus: o.currentStatus,
        priority: o.priority,
        receivedAt: o.receivedAt,
        enteredEmergencyAt: o.updatedAt,
        clinicId: o.clinicId,
        siteId: o.siteId,
        version: o.version,
        slaDeadlineAt: o.slaDeadlineAt,
        latestShipmentEvent:
          latestEvent !== undefined && latestShipment !== undefined
            ? Object.freeze({
                kind: latestEvent.kind,
                carrierStatus: latestEvent.carrierStatus,
                occurredAt: latestEvent.occurredAt,
                shipmentId: latestShipment.id,
              })
            : null,
      });
    });

    return Object.freeze({ bucketExists: true, rows });
  });
}
