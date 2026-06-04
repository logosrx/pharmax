import { afterEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const PV1_BUCKET_ID = "00000000-0000-4000-8000-000000000b03";

const prismaMock = {
  bucket: { findUnique: vi.fn() },
  order: { findMany: vi.fn() },
};

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
  withOrgScope: (_org: string, fn: () => unknown) => fn(),
  readInTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(prismaMock),
}));

const { listOrdersInBucketByCode, listOrdersInBucketsByCode } =
  await import("./list-orders-in-bucket.js");

afterEach(() => vi.clearAllMocks());

describe("listOrdersInBucketByCode", () => {
  it("returns bucketExists=false when the bucket is missing", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce(null);
    const result = await listOrdersInBucketByCode({
      organizationId: ORG_ID,
      bucketCode: "PV1",
    });
    expect(result.bucketExists).toBe(false);
    expect(result.rows).toEqual([]);
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
  });

  it("projects orders to the presentation row shape", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" });
    prismaMock.order.findMany.mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-0000000000aa",
        externalOrderNumber: "EXT-A",
        currentStatus: "TYPED_READY_FOR_PV1",
        priority: "RUSH",
        clinicId: CLINIC_ID,
        siteId: SITE_ID,
        receivedAt: new Date("2026-05-25T10:00:00.000Z"),
        updatedAt: new Date("2026-05-25T11:00:00.000Z"),
        slaDeadlineAt: new Date("2026-05-25T12:00:00.000Z"),
        currentAssigneeUserId: null,
        version: 2,
      },
      {
        id: "00000000-0000-4000-8000-0000000000ab",
        externalOrderNumber: null,
        currentStatus: "PV1_IN_PROGRESS",
        priority: "NORMAL",
        clinicId: CLINIC_ID,
        siteId: SITE_ID,
        receivedAt: new Date("2026-05-25T09:00:00.000Z"),
        updatedAt: new Date("2026-05-25T11:30:00.000Z"),
        slaDeadlineAt: null,
        currentAssigneeUserId: "00000000-0000-4000-8000-000000000009",
        version: 3,
      },
    ]);
    const result = await listOrdersInBucketByCode({
      organizationId: ORG_ID,
      bucketCode: "PV1",
    });
    expect(result.bucketExists).toBe(true);
    expect(result.bucketId).toBe(PV1_BUCKET_ID);
    expect(result.bucketName).toBe("PV1");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      currentStatus: "TYPED_READY_FOR_PV1",
      priority: "RUSH",
      currentAssigneeUserId: null,
    });
    expect(result.rows[1]?.currentAssigneeUserId).toBe("00000000-0000-4000-8000-000000000009");
  });

  it("orders by (priority DESC, slaDeadlineAt ASC, receivedAt ASC)", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" });
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    await listOrdersInBucketByCode({ organizationId: ORG_ID, bucketCode: "PV1" });
    const calls = prismaMock.order.findMany.mock.calls as unknown as Array<
      [{ orderBy: Array<Record<string, string>>; where: Record<string, unknown> }]
    >;
    expect(calls[0]![0].orderBy).toEqual([
      { priority: "desc" },
      { slaDeadlineAt: "asc" },
      { receivedAt: "asc" },
    ]);
    expect(calls[0]![0].where["currentBucketId"]).toBe(PV1_BUCKET_ID);
  });

  it("runs on a provided tx without opening its own scope", async () => {
    // A caller-supplied transaction (batching) must be used directly;
    // the module-level prismaMock (which the readInOrgScope mock would
    // hand in) must stay untouched — proving no dedicated scope opened.
    const fakeTx = {
      bucket: { findUnique: vi.fn().mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" }) },
      order: { findMany: vi.fn().mockResolvedValueOnce([]) },
    };
    const result = await listOrdersInBucketByCode({
      organizationId: ORG_ID,
      bucketCode: "PV1",
      tx: fakeTx as never,
    });
    expect(result.bucketExists).toBe(true);
    expect(result.bucketName).toBe("PV1");
    expect(fakeTx.bucket.findUnique).toHaveBeenCalledOnce();
    expect(prismaMock.bucket.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
  });
});

describe("listOrdersInBucketsByCode", () => {
  it("batches multiple bucket reads into one scope and keys results by code", async () => {
    prismaMock.bucket.findUnique
      .mockResolvedValueOnce({ id: "b-inbox", name: "INBOX" })
      .mockResolvedValueOnce({ id: "b-typing", name: "TYPING" });
    prismaMock.order.findMany.mockResolvedValue([]);

    const out = await listOrdersInBucketsByCode({
      organizationId: ORG_ID,
      bucketCodes: ["INBOX", "TYPING"],
    });

    expect(Object.keys(out)).toEqual(["INBOX", "TYPING"]);
    expect(out["INBOX"]?.bucketName).toBe("INBOX");
    expect(out["TYPING"]?.bucketName).toBe("TYPING");
    // One scope, two sequential bucket lookups on the shared tx.
    expect(prismaMock.bucket.findUnique).toHaveBeenCalledTimes(2);
  });
});
