// listShippingQueue contract tests.
//
// Asserts:
//   - Returns empty + bucketExists=false when the SHIPPING bucket
//     is not provisioned.
//   - Skips the shipment fan-out when there are no orders.
//   - Joins the most recent shipment per order (defensive against
//     legacy multi-shipment data — v1 commands forbid this).
//   - Orders without a shipment surface `shipment: null`.

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DatabaseModule from "@pharmax/database";

const ORG_ID = "00000000-0000-4000-8000-000000000001";

const prismaMock = {
  bucket: { findUnique: vi.fn() },
  order: { findMany: vi.fn() },
  shipment: { findMany: vi.fn() },
};

vi.mock("@pharmax/database", async () => {
  const actual = await vi.importActual<typeof DatabaseModule>("@pharmax/database");
  return {
    ...actual,
    prisma: prismaMock,
    readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
    withOrgScope: (_org: string, fn: () => unknown) => fn(),
    readInTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(prismaMock),
  };
});

const { listShippingQueue } = await import("./list-shipping-queue.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("listShippingQueue — SHIPPING bucket missing", () => {
  it("returns bucketExists=false and skips both fan-out queries", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce(null);
    const result = await listShippingQueue({ organizationId: ORG_ID });
    expect(result.bucketExists).toBe(false);
    expect(result.rows).toHaveLength(0);
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
    expect(prismaMock.shipment.findMany).not.toHaveBeenCalled();
  });
});

describe("listShippingQueue — empty bucket", () => {
  it("skips shipment fan-out when no orders are in the bucket", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: "b1", name: "Shipping" });
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    const result = await listShippingQueue({ organizationId: ORG_ID });
    expect(result.rows).toHaveLength(0);
    expect(prismaMock.shipment.findMany).not.toHaveBeenCalled();
  });
});

describe("listShippingQueue — happy path", () => {
  it("joins the most recent shipment per order, leaving null for orders without one", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: "b1", name: "Shipping" });
    prismaMock.order.findMany.mockResolvedValueOnce([
      {
        id: "o1",
        externalOrderNumber: "EXT-1",
        currentStatus: "READY_TO_SHIP",
        priority: "RUSH",
        clinicId: "c1",
        siteId: "s1",
        receivedAt: new Date("2026-05-25T10:00:00Z"),
        slaDeadlineAt: null,
        currentAssigneeUserId: "u1",
        version: 8,
      },
      {
        id: "o2",
        externalOrderNumber: "EXT-2",
        currentStatus: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
        priority: "NORMAL",
        clinicId: "c1",
        siteId: "s1",
        receivedAt: new Date("2026-05-25T09:00:00Z"),
        slaDeadlineAt: null,
        currentAssigneeUserId: null,
        version: 7,
      },
      {
        id: "o3",
        externalOrderNumber: "EXT-3",
        currentStatus: "SHIPPED",
        priority: "NORMAL",
        clinicId: "c1",
        siteId: "s1",
        receivedAt: new Date("2026-05-25T08:00:00Z"),
        slaDeadlineAt: null,
        currentAssigneeUserId: null,
        version: 10,
      },
    ]);
    // Two shipments for o1 to test the "most recent wins" rule;
    // one shipment for o3; nothing for o2.
    prismaMock.shipment.findMany.mockResolvedValueOnce([
      {
        id: "s-o1-new",
        orderId: "o1",
        status: "CREATED",
        carrier: "USPS",
        serviceLevel: "PRIORITY",
        trackingNumber: "9400-NEW",
        externalTrackerId: null,
        lastTrackingEventAt: null,
        lastTrackingEventKind: null,
        createdAt: new Date("2026-05-25T11:00:00Z"),
        confirmedAt: null,
      },
      {
        id: "s-o1-old",
        orderId: "o1",
        status: "CREATED",
        carrier: "USPS",
        serviceLevel: "PRIORITY",
        trackingNumber: "9400-OLD",
        externalTrackerId: null,
        lastTrackingEventAt: null,
        lastTrackingEventKind: null,
        createdAt: new Date("2026-05-25T10:30:00Z"),
        confirmedAt: null,
      },
      {
        id: "s-o3",
        orderId: "o3",
        status: "DELIVERED",
        carrier: "FEDEX",
        serviceLevel: "FEDEX_GROUND",
        trackingNumber: "FX-100",
        externalTrackerId: "trk_external",
        lastTrackingEventAt: new Date("2026-05-25T15:00:00Z"),
        lastTrackingEventKind: "DELIVERED",
        createdAt: new Date("2026-05-25T08:30:00Z"),
        confirmedAt: new Date("2026-05-25T09:00:00Z"),
      },
    ]);

    const result = await listShippingQueue({ organizationId: ORG_ID });
    expect(result.rows).toHaveLength(3);
    const byId = new Map(result.rows.map((r) => [r.orderId, r]));
    expect(byId.get("o1")?.shipment?.trackingNumber).toBe("9400-NEW");
    expect(byId.get("o2")?.shipment).toBeNull();
    expect(byId.get("o3")?.shipment?.lastTrackingEventKind).toBe("DELIVERED");
  });
});
