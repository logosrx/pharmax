// listEmergencyOrders contract tests.
//
// Stubs the Prisma client surface the helper touches. The function
// is a read-only projection so the tests focus on:
//   - Returns bucketExists=false when no EMERGENCY bucket exists.
//   - Projects orders → presentation rows with the right shape.
//   - Threads the latest shipment tracking event into each row.
//   - Honors the limit param.

import { afterEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const EMERGENCY_BUCKET_ID = "00000000-0000-4000-8000-000000000eee";
const ORDER_A = "00000000-0000-4000-8000-0000000000aa";
const ORDER_B = "00000000-0000-4000-8000-0000000000ab";

// Mocking `@pharmax/database`'s `prisma` export per test variant.
const prismaMock = {
  bucket: { findUnique: vi.fn() },
  order: { findMany: vi.fn() },
};

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
}));

// Import AFTER the mock so the helper picks up the stubbed export.
const { listEmergencyOrders } = await import("./list-emergency-orders.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("listEmergencyOrders — no bucket", () => {
  it("returns bucketExists=false when the EMERGENCY bucket is missing", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce(null);
    const result = await listEmergencyOrders({ organizationId: ORG_ID });
    expect(result.bucketExists).toBe(false);
    expect(result.rows).toEqual([]);
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
  });
});

describe("listEmergencyOrders — happy path", () => {
  it("projects orders into the presentation row shape", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: EMERGENCY_BUCKET_ID });
    prismaMock.order.findMany.mockResolvedValueOnce([
      {
        id: ORDER_A,
        externalOrderNumber: "EXT-A",
        currentStatus: "SHIPPED",
        priority: "RUSH",
        receivedAt: new Date("2026-05-01T10:00:00.000Z"),
        updatedAt: new Date("2026-05-25T12:00:00.000Z"),
        clinicId: CLINIC_ID,
        siteId: SITE_ID,
        version: 5,
        shipments: [
          {
            id: "shp-1",
            trackingEvents: [
              {
                kind: "EXCEPTION",
                carrierStatus: "DE",
                occurredAt: new Date("2026-05-25T11:55:00.000Z"),
              },
            ],
          },
        ],
      },
      {
        id: ORDER_B,
        externalOrderNumber: null,
        currentStatus: "SHIPPED",
        priority: "NORMAL",
        receivedAt: new Date("2026-05-02T10:00:00.000Z"),
        updatedAt: new Date("2026-05-25T13:00:00.000Z"),
        clinicId: CLINIC_ID,
        siteId: SITE_ID,
        version: 3,
        shipments: [],
      },
    ]);

    const result = await listEmergencyOrders({ organizationId: ORG_ID });

    expect(result.bucketExists).toBe(true);
    expect(result.rows).toHaveLength(2);

    expect(result.rows[0]).toMatchObject({
      orderId: ORDER_A,
      externalOrderNumber: "EXT-A",
      priority: "RUSH",
      latestShipmentEvent: {
        kind: "EXCEPTION",
        carrierStatus: "DE",
        shipmentId: "shp-1",
      },
    });
    expect(result.rows[1]).toMatchObject({
      orderId: ORDER_B,
      externalOrderNumber: null,
      latestShipmentEvent: null,
    });
  });

  it("honors an explicit limit", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: EMERGENCY_BUCKET_ID });
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    await listEmergencyOrders({ organizationId: ORG_ID, limit: 25 });
    const calls = prismaMock.order.findMany.mock.calls as unknown as Array<
      [{ take?: number; where: Record<string, unknown> }]
    >;
    expect(calls[0]![0].take).toBe(25);
    expect(calls[0]![0].where["organizationId"]).toBe(ORG_ID);
    expect(calls[0]![0].where["currentBucketId"]).toBe(EMERGENCY_BUCKET_ID);
  });
});
