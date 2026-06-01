// Contract tests for `listRecentPackagePhotoCaptures`.
//
// Asserts:
//   - Filter scoped to (organizationId, capturedByUserId) — never
//     leaks peer captures.
//   - Newest-first ordering passed through to Prisma.
//   - Default + clamped limits.
//   - Selection projects ONLY structural fields (no `notesEnc`).
//   - Returned rows are frozen.

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DatabaseModule from "@pharmax/database";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000aa";

const prismaMock = {
  packagePhoto: { findMany: vi.fn() },
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

const { listRecentPackagePhotoCaptures } = await import("./list-recent-package-photo-captures.js");

afterEach(() => {
  vi.clearAllMocks();
});

const ROW_BASE = {
  id: "p-1",
  capturedAt: new Date("2026-05-29T14:00:00.000Z"),
  pharmacyExternalOrderNumber: "ORD-001",
  matched: true,
  matchStrategy: "EXTERNAL_ORDER_NUMBER" as const,
  matchedOrderId: "o-1",
  matchedPatientId: "pt-1",
  trackingNumber: "1Z999",
  trackingSource: "ORDER" as const,
  sha256: "deadbeef",
  contentType: "image/jpeg",
  fileSize: 12_345,
};

describe("listRecentPackagePhotoCaptures — scoping", () => {
  it("filters strictly by (organizationId, capturedByUserId)", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);

    await listRecentPackagePhotoCaptures({
      organizationId: ORG_ID,
      capturedByUserId: USER_ID,
    });

    expect(prismaMock.packagePhoto.findMany).toHaveBeenCalledTimes(1);
    const call = prismaMock.packagePhoto.findMany.mock.calls[0]![0]!;
    expect(call.where).toEqual({
      organizationId: ORG_ID,
      capturedByUserId: USER_ID,
    });
  });

  it("orders newest-first by capturedAt", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listRecentPackagePhotoCaptures({
      organizationId: ORG_ID,
      capturedByUserId: USER_ID,
    });
    const call = prismaMock.packagePhoto.findMany.mock.calls[0]![0]!;
    expect(call.orderBy).toEqual({ capturedAt: "desc" });
  });

  it("does NOT select the encrypted notes column", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listRecentPackagePhotoCaptures({
      organizationId: ORG_ID,
      capturedByUserId: USER_ID,
    });
    const call = prismaMock.packagePhoto.findMany.mock.calls[0]![0]!;
    expect(call.select).toBeDefined();
    expect("notesEnc" in call.select).toBe(false);
  });
});

describe("listRecentPackagePhotoCaptures — limit handling", () => {
  it("defaults to 10 when limit is omitted", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listRecentPackagePhotoCaptures({
      organizationId: ORG_ID,
      capturedByUserId: USER_ID,
    });
    expect(prismaMock.packagePhoto.findMany.mock.calls[0]![0]!.take).toBe(10);
  });

  it("clamps to a 50-row max even when caller asks for more", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listRecentPackagePhotoCaptures({
      organizationId: ORG_ID,
      capturedByUserId: USER_ID,
      limit: 9999,
    });
    expect(prismaMock.packagePhoto.findMany.mock.calls[0]![0]!.take).toBe(50);
  });

  it("falls back to the default for non-positive or non-finite limits", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listRecentPackagePhotoCaptures({
      organizationId: ORG_ID,
      capturedByUserId: USER_ID,
      limit: 0,
    });
    expect(prismaMock.packagePhoto.findMany.mock.calls[0]![0]!.take).toBe(10);

    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listRecentPackagePhotoCaptures({
      organizationId: ORG_ID,
      capturedByUserId: USER_ID,
      limit: Number.NaN,
    });
    expect(prismaMock.packagePhoto.findMany.mock.calls[1]![0]!.take).toBe(10);
  });

  it("floors fractional limits", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    await listRecentPackagePhotoCaptures({
      organizationId: ORG_ID,
      capturedByUserId: USER_ID,
      limit: 7.7,
    });
    expect(prismaMock.packagePhoto.findMany.mock.calls[0]![0]!.take).toBe(7);
  });
});

describe("listRecentPackagePhotoCaptures — row mapping", () => {
  it("maps every column and freezes each row", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([
      ROW_BASE,
      {
        ...ROW_BASE,
        id: "p-2",
        matched: false,
        matchStrategy: "UNMATCHED",
        matchedOrderId: null,
        matchedPatientId: null,
        trackingNumber: null,
        trackingSource: null,
      },
    ]);

    const out = await listRecentPackagePhotoCaptures({
      organizationId: ORG_ID,
      capturedByUserId: USER_ID,
    });

    expect(out).toHaveLength(2);

    const matched = out[0]!;
    expect(matched.photoId).toBe("p-1");
    expect(matched.matched).toBe(true);
    expect(matched.matchStrategy).toBe("EXTERNAL_ORDER_NUMBER");
    expect(matched.matchedOrderId).toBe("o-1");
    expect(matched.trackingNumber).toBe("1Z999");
    expect(matched.trackingSource).toBe("ORDER");
    expect(matched.sha256).toBe("deadbeef");
    expect(Object.isFrozen(matched)).toBe(true);

    const unmatched = out[1]!;
    expect(unmatched.matched).toBe(false);
    expect(unmatched.matchStrategy).toBe("UNMATCHED");
    expect(unmatched.matchedOrderId).toBeNull();
    expect(unmatched.trackingNumber).toBeNull();
  });

  it("returns an empty array when the operator has no captures yet", async () => {
    prismaMock.packagePhoto.findMany.mockResolvedValueOnce([]);
    const out = await listRecentPackagePhotoCaptures({
      organizationId: ORG_ID,
      capturedByUserId: USER_ID,
    });
    expect(out).toEqual([]);
  });
});
