// Contract tests for `searchOrdersForPhotoMatch`.
//
// Asserts:
//   - Refuses (tooShort) below the min query length — no DB hit.
//   - Trims the query before length-checking.
//   - Case-insensitive substring filter scoped to the org.
//   - Over-fetch-by-one truncation reporting (take = MAX + 1).
//   - Maps `_count.shipments` → `hasShipment` boolean.
//   - Rows frozen on return.

import { afterEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const SITE_ID = "00000000-0000-4000-8000-000000000003";

const prismaMock = {
  order: { findMany: vi.fn() },
};

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
  readInTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(prismaMock),
}));

const { searchOrdersForPhotoMatch } = await import("./search-orders-for-photo-match.js");

afterEach(() => vi.clearAllMocks());

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "o-1",
    externalOrderNumber: "ORD-001",
    currentStatus: "READY_TO_SHIP",
    priority: "NORMAL",
    clinicId: CLINIC_ID,
    siteId: SITE_ID,
    receivedAt: new Date("2026-05-29T12:00:00.000Z"),
    _count: { shipments: 0 },
    ...overrides,
  };
}

describe("searchOrdersForPhotoMatch — query guards", () => {
  it("returns tooShort without hitting the DB for a 1-char query", async () => {
    const out = await searchOrdersForPhotoMatch({ organizationId: ORG_ID, query: "O" });
    expect(out.tooShort).toBe(true);
    expect(out.rows).toEqual([]);
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
  });

  it("trims whitespace before the length check (a padded 1-char stays too short)", async () => {
    const out = await searchOrdersForPhotoMatch({ organizationId: ORG_ID, query: "   x   " });
    expect(out.tooShort).toBe(true);
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
  });

  it("runs the search for a 2-char query", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    const out = await searchOrdersForPhotoMatch({ organizationId: ORG_ID, query: "OR" });
    expect(out.tooShort).toBe(false);
    expect(prismaMock.order.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("searchOrdersForPhotoMatch — filter shape", () => {
  it("filters by org + case-insensitive substring on externalOrderNumber", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    await searchOrdersForPhotoMatch({ organizationId: ORG_ID, query: "  ord-001  " });
    const call = prismaMock.order.findMany.mock.calls[0]![0]!;
    expect(call.where).toEqual({
      organizationId: ORG_ID,
      externalOrderNumber: { contains: "ord-001", mode: "insensitive" },
    });
    expect(call.orderBy).toEqual({ receivedAt: "desc" });
  });

  it("over-fetches by one (take = 26)", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    await searchOrdersForPhotoMatch({ organizationId: ORG_ID, query: "ORD" });
    expect(prismaMock.order.findMany.mock.calls[0]![0]!.take).toBe(26);
  });
});

describe("searchOrdersForPhotoMatch — result mapping", () => {
  it("maps _count.shipments to hasShipment and freezes rows", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([
      orderRow({ id: "o-1", _count: { shipments: 0 } }),
      orderRow({ id: "o-2", externalOrderNumber: "ORD-002", _count: { shipments: 2 } }),
    ]);
    const out = await searchOrdersForPhotoMatch({ organizationId: ORG_ID, query: "ORD" });
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]!.hasShipment).toBe(false);
    expect(out.rows[0]!.orderId).toBe("o-1");
    expect(out.rows[1]!.hasShipment).toBe(true);
    expect(out.rows[1]!.externalOrderNumber).toBe("ORD-002");
    expect(Object.isFrozen(out.rows[0]!)).toBe(true);
    expect(out.truncated).toBe(false);
  });

  it("reports truncated=true and trims the extra row when the cap is exceeded", async () => {
    const rows = Array.from({ length: 26 }, (_v, i) => orderRow({ id: `o-${i}` }));
    prismaMock.order.findMany.mockResolvedValueOnce(rows);
    const out = await searchOrdersForPhotoMatch({ organizationId: ORG_ID, query: "ORD" });
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(25);
  });

  it("returns an empty non-truncated result when nothing matches", async () => {
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    const out = await searchOrdersForPhotoMatch({ organizationId: ORG_ID, query: "ZZZ" });
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(out.tooShort).toBe(false);
  });
});
