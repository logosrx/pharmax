// Contract tests for `listUnmatchedPackagePhotos`.
//
// Asserts:
//   - Filter is scoped to (organizationId, matched=false).
//   - Newest-first ordering passed to Prisma.
//   - Over-fetch-by-one truncation reporting (take = limit + 1).
//   - Default + clamped + NaN-safe limits.
//   - Selection projects ONLY structural fields (no `notesEnc`).
//   - Rows frozen on return.

import { afterEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";

const prismaMock = {
  packagePhoto: { findMany: vi.fn() },
};

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
  readInTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(prismaMock),
}));

const { listUnmatchedPackagePhotos } = await import("./list-unmatched-package-photos.js");

afterEach(() => vi.clearAllMocks());

const ROW_BASE = {
  id: "p-1",
  capturedAt: new Date("2026-05-29T14:00:00.000Z"),
  capturedByUserId: "00000000-0000-4000-8000-0000000000aa",
  siteId: "00000000-0000-4000-8000-000000000003",
  pharmacyExternalOrderNumber: "ORD-0O1", // note the typo'd letter-O — the whole point
  trackingNumber: null,
  trackingSource: null,
  contentType: "image/jpeg",
  fileSize: 9_876,
  sha256: "cafebabe1234",
};

describe("listUnmatchedPackagePhotos — scoping + ordering", () => {
  it("filters by (organizationId, matched=false)", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listUnmatchedPackagePhotos({ organizationId: ORG_ID });
    const call = prismaMock.packagePhoto.findMany.mock.calls[0]![0]!;
    expect(call.where).toEqual({ organizationId: ORG_ID, matched: false, archivedAt: null });
  });

  it("orders newest-first by capturedAt", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listUnmatchedPackagePhotos({ organizationId: ORG_ID });
    const call = prismaMock.packagePhoto.findMany.mock.calls[0]![0]!;
    expect(call.orderBy).toEqual({ capturedAt: "desc" });
  });

  it("does NOT select the encrypted notes column", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listUnmatchedPackagePhotos({ organizationId: ORG_ID });
    const call = prismaMock.packagePhoto.findMany.mock.calls[0]![0]!;
    expect(call.select).toBeDefined();
    expect("notesEnc" in call.select).toBe(false);
  });
});

describe("listUnmatchedPackagePhotos — limit + truncation", () => {
  it("defaults to take=101 (limit 100 + 1 over-fetch)", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listUnmatchedPackagePhotos({ organizationId: ORG_ID });
    expect(prismaMock.packagePhoto.findMany.mock.calls[0]![0]!.take).toBe(101);
  });

  it("clamps the limit to a 200 max (take=201)", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listUnmatchedPackagePhotos({ organizationId: ORG_ID, limit: 99999 });
    expect(prismaMock.packagePhoto.findMany.mock.calls[0]![0]!.take).toBe(201);
  });

  it("falls back to the default for non-positive / NaN limits", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listUnmatchedPackagePhotos({ organizationId: ORG_ID, limit: 0 });
    expect(prismaMock.packagePhoto.findMany.mock.calls[0]![0]!.take).toBe(101);

    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listUnmatchedPackagePhotos({ organizationId: ORG_ID, limit: Number.NaN });
    expect(prismaMock.packagePhoto.findMany.mock.calls[1]![0]!.take).toBe(101);
  });

  it("reports truncated=true and trims the extra row when the over-fetch hits", async () => {
    // limit 2 → take 3; return 3 rows → truncated, 2 visible.
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([
      { ...ROW_BASE, id: "p-1" },
      { ...ROW_BASE, id: "p-2" },
      { ...ROW_BASE, id: "p-3" },
    ]);
    const out = await listUnmatchedPackagePhotos({ organizationId: ORG_ID, limit: 2 });
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(2);
    expect(out.rows.map((r) => r.photoId)).toEqual(["p-1", "p-2"]);
  });

  it("reports truncated=false when the result fits", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([
      { ...ROW_BASE, id: "p-1" },
      { ...ROW_BASE, id: "p-2" },
    ]);
    const out = await listUnmatchedPackagePhotos({ organizationId: ORG_ID, limit: 2 });
    expect(out.truncated).toBe(false);
    expect(out.rows).toHaveLength(2);
  });
});

describe("listUnmatchedPackagePhotos — row mapping", () => {
  it("maps every column and freezes each row", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([
      ROW_BASE,
      {
        ...ROW_BASE,
        id: "p-2",
        trackingNumber: "1Z-MANUAL",
        trackingSource: "MANUAL",
      },
    ]);
    const out = await listUnmatchedPackagePhotos({ organizationId: ORG_ID });
    expect(out.rows).toHaveLength(2);

    const first = out.rows[0]!;
    expect(first.photoId).toBe("p-1");
    expect(first.pharmacyExternalOrderNumber).toBe("ORD-0O1");
    expect(first.trackingNumber).toBeNull();
    expect(first.trackingSource).toBeNull();
    expect(first.contentType).toBe("image/jpeg");
    expect(first.sha256).toBe("cafebabe1234");
    expect(Object.isFrozen(first)).toBe(true);

    const second = out.rows[1]!;
    expect(second.trackingNumber).toBe("1Z-MANUAL");
    expect(second.trackingSource).toBe("MANUAL");
  });

  it("returns an empty array + truncated=false when nothing is unmatched", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    const out = await listUnmatchedPackagePhotos({ organizationId: ORG_ID });
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
  });
});
