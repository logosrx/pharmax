// Shipping queue projection — drives `/ops/shipping`.
//
// Shape mirrors `listOrdersInBucketByCode` for orders in the
// `SHIPPING` bucket, but joins the most recent `Shipment` (if
// any) so the page can render per-row action chrome based on
// substate:
//
//   - FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP: no shipment;
//     the operator needs to call ReleaseToShip first.
//   - READY_TO_SHIP, no shipment: the assignee can either
//     CreateShipment (manual tracking number) or PurchaseShipmentLabel
//     (carrier-broker, deferred until ship-from address admin
//     lands — not surfaced in this slice).
//   - READY_TO_SHIP, has shipment: the assignee can ConfirmShipment
//     to release physically and transition to SHIPPED.
//   - SHIPPED: terminal; render the carrier + tracking number.
//
// Each order has AT MOST one shipment row in v1 — the command
// surface (CreateShipment / PurchaseShipmentLabel) both reject
// with `SHIPMENT_ALREADY_EXISTS` on a second insert per order.
// We therefore pick the most recent shipment per order rather
// than collecting an array.
//
// PHI: queue surface is non-PHI. The order-detail page is where
// the patient + recipient address is decrypted (when the
// PurchaseShipmentLabel slice lands).

import "server-only";

import {
  prisma,
  type OrderPriority,
  type OrderStatus,
  type ShipmentCarrier,
  type ShipmentStatus,
} from "@pharmax/database";

export interface ShippingQueueShipment {
  readonly shipmentId: string;
  readonly status: ShipmentStatus;
  readonly carrier: ShipmentCarrier;
  readonly serviceLevel: string;
  readonly trackingNumber: string;
  readonly externalTrackerId: string | null;
  readonly lastTrackingEventAt: Date | null;
  readonly lastTrackingEventKind: string | null;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
}

export interface ShippingQueueRow {
  readonly orderId: string;
  readonly externalOrderNumber: string | null;
  readonly currentStatus: OrderStatus;
  readonly priority: OrderPriority;
  readonly clinicId: string;
  readonly siteId: string;
  readonly receivedAt: Date;
  readonly slaDeadlineAt: Date | null;
  readonly currentAssigneeUserId: string | null;
  readonly version: number;
  readonly shipment: ShippingQueueShipment | null;
}

export interface ListShippingQueueResult {
  readonly bucketExists: boolean;
  readonly bucketId: string | null;
  readonly bucketName: string | null;
  readonly rows: ReadonlyArray<ShippingQueueRow>;
}

export async function listShippingQueue(input: {
  readonly organizationId: string;
  readonly limit?: number;
}): Promise<ListShippingQueueResult> {
  const limit = Math.min(input.limit ?? 100, 500);

  const bucket = await prisma.bucket.findUnique({
    where: {
      organizationId_code: {
        organizationId: input.organizationId,
        code: "SHIPPING",
      },
    },
    select: { id: true, name: true },
  });
  if (bucket === null) {
    return Object.freeze({
      bucketExists: false,
      bucketId: null,
      bucketName: null,
      rows: [],
    });
  }

  const orders = await prisma.order.findMany({
    where: {
      organizationId: input.organizationId,
      currentBucketId: bucket.id,
    },
    select: {
      id: true,
      externalOrderNumber: true,
      currentStatus: true,
      priority: true,
      clinicId: true,
      siteId: true,
      receivedAt: true,
      slaDeadlineAt: true,
      currentAssigneeUserId: true,
      version: true,
    },
    orderBy: [{ priority: "desc" }, { slaDeadlineAt: "asc" }, { receivedAt: "asc" }],
    take: limit,
  });

  if (orders.length === 0) {
    return Object.freeze({
      bucketExists: true,
      bucketId: bucket.id,
      bucketName: bucket.name,
      rows: [],
    });
  }

  // Fetch shipments for these orders in one round-trip. We sort
  // newest-first and reduce to a per-order map keyed on
  // `orderId` — v1 enforces at most one shipment per order at the
  // command layer, but we pick the most recent to be defensive
  // against any historical data drift.
  const shipments = await prisma.shipment.findMany({
    where: {
      organizationId: input.organizationId,
      orderId: { in: orders.map((o) => o.id) },
    },
    select: {
      id: true,
      orderId: true,
      status: true,
      carrier: true,
      serviceLevel: true,
      trackingNumber: true,
      externalTrackerId: true,
      lastTrackingEventAt: true,
      lastTrackingEventKind: true,
      createdAt: true,
      confirmedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const shipmentByOrderId = new Map<string, ShippingQueueShipment>();
  for (const s of shipments) {
    if (shipmentByOrderId.has(s.orderId)) continue;
    shipmentByOrderId.set(
      s.orderId,
      Object.freeze({
        shipmentId: s.id,
        status: s.status,
        carrier: s.carrier,
        serviceLevel: s.serviceLevel,
        trackingNumber: s.trackingNumber,
        externalTrackerId: s.externalTrackerId,
        lastTrackingEventAt: s.lastTrackingEventAt,
        lastTrackingEventKind: s.lastTrackingEventKind,
        createdAt: s.createdAt,
        confirmedAt: s.confirmedAt,
      })
    );
  }

  return Object.freeze({
    bucketExists: true,
    bucketId: bucket.id,
    bucketName: bucket.name,
    rows: orders.map((o) =>
      Object.freeze({
        orderId: o.id,
        externalOrderNumber: o.externalOrderNumber,
        currentStatus: o.currentStatus,
        priority: o.priority,
        clinicId: o.clinicId,
        siteId: o.siteId,
        receivedAt: o.receivedAt,
        slaDeadlineAt: o.slaDeadlineAt,
        currentAssigneeUserId: o.currentAssigneeUserId,
        version: o.version,
        shipment: shipmentByOrderId.get(o.id) ?? null,
      })
    ),
  });
}
