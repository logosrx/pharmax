import { afterEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const PV1_BUCKET_ID = "00000000-0000-4000-8000-000000000b03";

const prismaMock = {
  bucket: { findUnique: vi.fn() },
  order: { findMany: vi.fn(), count: vi.fn() },
};

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
  withOrgScope: (_org: string, fn: () => unknown) => fn(),
  readInTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(prismaMock),
  OrderPriority: { NORMAL: "NORMAL", RUSH: "RUSH", EMERGENCY: "EMERGENCY" },
}));

const {
  listOrdersInBucketByCode,
  listOrdersInBucketsByCode,
  QUEUE_PAGE_SIZE,
  QUEUE_MAX_PAGE_SIZE,
} = await import("./list-orders-in-bucket.js");

/** One projected order row, with only the fields a test cares about overridden. */
function orderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

type FindManyArgs = {
  orderBy: Array<Record<string, string>>;
  where: Record<string, unknown>;
  take: number;
  cursor?: { id: string };
  skip?: number;
};

function findManyArgs(callIndex = 0): FindManyArgs {
  const calls = prismaMock.order.findMany.mock.calls as unknown as Array<[FindManyArgs]>;
  return calls[callIndex]![0];
}

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
    expect(result.nextCursor).toBeNull();
    expect(result.totalMatching).toBe(0);
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
    // No count either — a missing bucket short-circuits both reads.
    expect(prismaMock.order.count).not.toHaveBeenCalled();
  });

  it("projects orders to the presentation row shape", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" });
    prismaMock.order.count.mockResolvedValueOnce(2);
    prismaMock.order.findMany.mockResolvedValueOnce([
      orderRow(),
      orderRow({
        id: "00000000-0000-4000-8000-0000000000ab",
        externalOrderNumber: null,
        currentStatus: "PV1_IN_PROGRESS",
        priority: "NORMAL",
        receivedAt: new Date("2026-05-25T09:00:00.000Z"),
        slaDeadlineAt: null,
        currentAssigneeUserId: "00000000-0000-4000-8000-000000000009",
        version: 3,
      }),
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

  it("orders by (priority DESC, slaDeadlineAt ASC, receivedAt ASC, id ASC)", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" });
    prismaMock.order.count.mockResolvedValueOnce(0);
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    await listOrdersInBucketByCode({ organizationId: ORG_ID, bucketCode: "PV1" });
    // `id` last makes the sort total. Without it a cursor boundary
    // between two otherwise-equal rows could repeat or skip one.
    expect(findManyArgs().orderBy).toEqual([
      { priority: "desc" },
      { slaDeadlineAt: "asc" },
      { receivedAt: "asc" },
      { id: "asc" },
    ]);
    expect(findManyArgs().where["currentBucketId"]).toBe(PV1_BUCKET_ID);
  });

  it("runs on a provided tx without opening its own scope", async () => {
    // A caller-supplied transaction (batching) must be used directly;
    // the module-level prismaMock (which the readInOrgScope mock would
    // hand in) must stay untouched — proving no dedicated scope opened.
    const fakeTx = {
      bucket: { findUnique: vi.fn().mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" }) },
      order: {
        findMany: vi.fn().mockResolvedValueOnce([]),
        count: vi.fn().mockResolvedValueOnce(0),
      },
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

describe("listOrdersInBucketByCode pagination", () => {
  it("defaults to the small page size, because each row costs a PHI decrypt", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" });
    prismaMock.order.count.mockResolvedValueOnce(0);
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    await listOrdersInBucketByCode({ organizationId: ORG_ID, bucketCode: "PV1" });
    // limit + 1: the extra row detects a further page without a second query.
    expect(findManyArgs().take).toBe(QUEUE_PAGE_SIZE + 1);
  });

  it("clamps an oversized limit to the ceiling", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" });
    prismaMock.order.count.mockResolvedValueOnce(0);
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    await listOrdersInBucketByCode({ organizationId: ORG_ID, bucketCode: "PV1", limit: 5_000 });
    expect(findManyArgs().take).toBe(QUEUE_MAX_PAGE_SIZE + 1);
  });

  it("drops the probe row and returns its predecessor as the cursor", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" });
    prismaMock.order.count.mockResolvedValueOnce(9);
    // Three rows for a page size of two: the third only says "more exists".
    prismaMock.order.findMany.mockResolvedValueOnce([
      orderRow({ id: "00000000-0000-4000-8000-00000000000a" }),
      orderRow({ id: "00000000-0000-4000-8000-00000000000b" }),
      orderRow({ id: "00000000-0000-4000-8000-00000000000c" }),
    ]);
    const result = await listOrdersInBucketByCode({
      organizationId: ORG_ID,
      bucketCode: "PV1",
      limit: 2,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.nextCursor).toBe("00000000-0000-4000-8000-00000000000b");
    expect(result.totalMatching).toBe(9);
  });

  it("reports no next page when the probe row does not come back", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" });
    prismaMock.order.count.mockResolvedValueOnce(2);
    prismaMock.order.findMany.mockResolvedValueOnce([
      orderRow({ id: "00000000-0000-4000-8000-00000000000a" }),
      orderRow({ id: "00000000-0000-4000-8000-00000000000b" }),
    ]);
    const result = await listOrdersInBucketByCode({
      organizationId: ORG_ID,
      bucketCode: "PV1",
      limit: 2,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("skips the cursor row itself so a page boundary does not repeat it", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" });
    prismaMock.order.count.mockResolvedValueOnce(3);
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    await listOrdersInBucketByCode({
      organizationId: ORG_ID,
      bucketCode: "PV1",
      cursor: "00000000-0000-4000-8000-00000000000b",
    });
    expect(findManyArgs().cursor).toEqual({ id: "00000000-0000-4000-8000-00000000000b" });
    expect(findManyArgs().skip).toBe(1);
  });

  it("counts the whole filtered set, not just the page", async () => {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" });
    prismaMock.order.count.mockResolvedValueOnce(340);
    prismaMock.order.findMany.mockResolvedValueOnce([orderRow()]);
    const result = await listOrdersInBucketByCode({
      organizationId: ORG_ID,
      bucketCode: "PV1",
      limit: 1,
    });
    expect(result.totalMatching).toBe(340);
    // The count must use the same predicate as the page read, or the
    // header would claim a backlog the filters exclude.
    const countArgs = prismaMock.order.count.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(countArgs.where).toEqual(findManyArgs().where);
  });
});

describe("listOrdersInBucketByCode filters", () => {
  async function whereForFilters(
    filters: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    prismaMock.bucket.findUnique.mockResolvedValueOnce({ id: PV1_BUCKET_ID, name: "PV1" });
    prismaMock.order.count.mockResolvedValueOnce(0);
    prismaMock.order.findMany.mockResolvedValueOnce([]);
    await listOrdersInBucketByCode({
      organizationId: ORG_ID,
      bucketCode: "PV1",
      filters: filters as never,
    });
    return findManyArgs().where;
  }

  it("always scopes to the organization and the bucket", async () => {
    const where = await whereForFilters({});
    expect(where["organizationId"]).toBe(ORG_ID);
    expect(where["currentBucketId"]).toBe(PV1_BUCKET_ID);
  });

  it("omits every predicate for a filter that was not supplied", async () => {
    const where = await whereForFilters({});
    expect(where).not.toHaveProperty("clinicId");
    expect(where).not.toHaveProperty("siteId");
    expect(where).not.toHaveProperty("priority");
    expect(where).not.toHaveProperty("slaDeadlineAt");
    expect(where).not.toHaveProperty("currentAssigneeUserId");
  });

  it("narrows by client, site and priority", async () => {
    const where = await whereForFilters({
      clinicId: CLINIC_ID,
      siteId: SITE_ID,
      priority: "RUSH",
    });
    expect(where["clinicId"]).toBe(CLINIC_ID);
    expect(where["siteId"]).toBe(SITE_ID);
    expect(where["priority"]).toBe("RUSH");
  });

  it("expresses an SLA breach as a deadline in the past, not a stored flag", async () => {
    const where = await whereForFilters({ breachedOnly: true });
    const deadline = where["slaDeadlineAt"] as { lt: Date };
    expect(deadline.lt).toBeInstanceOf(Date);
    // Rows with no deadline are excluded by `lt` rather than counted as
    // breached, which is the intent: no deadline is not a breach.
  });

  it("treats unclaimed as a null assignee", async () => {
    const where = await whereForFilters({ unclaimedOnly: true });
    expect(where["currentAssigneeUserId"]).toBeNull();
  });
});

describe("listOrdersInBucketsByCode", () => {
  it("batches multiple bucket reads into one scope and keys results by code", async () => {
    prismaMock.bucket.findUnique
      .mockResolvedValueOnce({ id: "b-inbox", name: "INBOX" })
      .mockResolvedValueOnce({ id: "b-typing", name: "TYPING" });
    prismaMock.order.count.mockResolvedValue(0);
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

  it("applies each bucket's own cursor, so paging one list leaves the other alone", async () => {
    prismaMock.bucket.findUnique
      .mockResolvedValueOnce({ id: "b-inbox", name: "INBOX" })
      .mockResolvedValueOnce({ id: "b-typing", name: "TYPING" });
    prismaMock.order.count.mockResolvedValue(0);
    prismaMock.order.findMany.mockResolvedValue([]);

    await listOrdersInBucketsByCode({
      organizationId: ORG_ID,
      bucketCodes: ["INBOX", "TYPING"],
      cursors: { TYPING: "00000000-0000-4000-8000-00000000000b" },
    });

    // INBOX had no cursor and must not inherit TYPING's.
    expect(findManyArgs(0).cursor).toBeUndefined();
    expect(findManyArgs(1).cursor).toEqual({ id: "00000000-0000-4000-8000-00000000000b" });
  });

  it("applies shared filters to every bucket in the batch", async () => {
    prismaMock.bucket.findUnique
      .mockResolvedValueOnce({ id: "b-inbox", name: "INBOX" })
      .mockResolvedValueOnce({ id: "b-typing", name: "TYPING" });
    prismaMock.order.count.mockResolvedValue(0);
    prismaMock.order.findMany.mockResolvedValue([]);

    await listOrdersInBucketsByCode({
      organizationId: ORG_ID,
      bucketCodes: ["INBOX", "TYPING"],
      filters: { clinicId: CLINIC_ID },
    });

    expect(findManyArgs(0).where["clinicId"]).toBe(CLINIC_ID);
    expect(findManyArgs(1).where["clinicId"]).toBe(CLINIC_ID);
  });
});
