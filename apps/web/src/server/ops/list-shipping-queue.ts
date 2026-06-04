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
  readInOrgScope,
  type OrderPriority,
  type OrderStatus,
  type ShipmentCarrier,
  type ShipmentStatus,
  type ShippingProvider,
  type TenantTransactionClient,
} from "@pharmax/database";

import { listActiveProviders } from "./list-carrier-credentials.js";
import { listPharmacySites, type PharmacySiteRow } from "./list-pharmacy-sites.js";

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
  /**
   * Optional shared tenant-scoped transaction (batching). Provide it
   * to run this read inside an outer `readInOrgScope` alongside the
   * other shipping-page reads — one connection instead of one per
   * read. Omit to open a dedicated scope. MUST already be scoped to
   * `organizationId`.
   */
  readonly tx?: TenantTransactionClient;
}): Promise<ListShippingQueueResult> {
  const limit = Math.min(input.limit ?? 100, 500);

  const run = async (tx: TenantTransactionClient): Promise<ListShippingQueueResult> => {
    const bucket = await tx.bucket.findUnique({
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
    const shipments = await tx.shipment.findMany({
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
  };

  return input.tx !== undefined ? run(input.tx) : readInOrgScope(input.organizationId, run);
}

export interface ShippingQueuePageData {
  readonly queue: ListShippingQueueResult;
  /** Providers for which the org has an ACTIVE carrier credential. */
  readonly availableProviders: ReadonlyArray<ShippingProvider>;
  readonly sites: ReadonlyArray<PharmacySiteRow>;
}

/**
 * Load everything the `/ops/shipping` page needs in ONE tenant-scoped
 * transaction: the shipping queue (+ batched shipments), the active
 * carrier providers, and the pharmacy sites (for ship-from address
 * completeness).
 *
 * Previously the page issued these as three independent
 * `readInOrgScope` calls via `Promise.all`, opening three concurrent
 * transactions on three pooled connections per render. At enterprise
 * concurrency that tripled the connection pressure for the shipping
 * surface. Collapsing into one scope holds a single connection and
 * pays the BEGIN/GUC/COMMIT once. The reads run sequentially (a Prisma
 * interactive transaction serializes queries on its one connection),
 * which is a negligible latency trade for the connection-pressure win.
 */
export async function loadShippingQueuePageData(input: {
  readonly organizationId: string;
  readonly limit?: number;
}): Promise<ShippingQueuePageData> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const queue = await listShippingQueue({
      organizationId: input.organizationId,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      tx,
    });
    const availableProviders = await listActiveProviders({
      organizationId: input.organizationId,
      tx,
    });
    const sites = await listPharmacySites({ organizationId: input.organizationId, tx });
    return Object.freeze({ queue, availableProviders, sites });
  });
}
