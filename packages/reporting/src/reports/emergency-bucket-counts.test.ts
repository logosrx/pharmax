import { BucketKind, OrderStatus } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { emergencyBucketCountsReport } from "./emergency-bucket-counts.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const EMERGENCY_BUCKET_ID = "00000000-0000-4000-8000-000000000010";
const RUSH_BUCKET_ID = "00000000-0000-4000-8000-000000000011";

const NOW = new Date("2026-05-10T12:00:00.000Z");

interface FakeBucket {
  id: string;
  code: string;
  name: string;
}

interface FakeGroup {
  currentBucketId: string;
  currentStatus: OrderStatus;
  _count: { _all: number };
  _min: { receivedAt: Date | null };
}

const EMERGENCY_BUCKET: FakeBucket = {
  id: EMERGENCY_BUCKET_ID,
  code: "EMERGENCY",
  name: "Emergency",
};
const RUSH_BUCKET: FakeBucket = { id: RUSH_BUCKET_ID, code: "AAA_RUSH", name: "Rush escalations" };

/** A grouping whose oldest order arrived `hoursAgo` before `NOW`. */
function group(
  bucketId: string,
  currentStatus: OrderStatus,
  count: number,
  hoursAgo: number
): FakeGroup {
  return {
    currentBucketId: bucketId,
    currentStatus,
    _count: { _all: count },
    _min: { receivedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000) },
  };
}

function fakeClient(
  buckets: ReadonlyArray<FakeBucket>,
  groups: ReadonlyArray<FakeGroup>,
  openOrders: number
) {
  return {
    bucket: { findMany: vi.fn(async (_args: unknown) => buckets) },
    order: {
      groupBy: vi.fn(async (_args: unknown) => groups),
      count: vi.fn(async (_args: unknown) => openOrders),
    },
  };
}

const ctx = { organizationId: ORG_ID, asOf: NOW };

afterEach(() => vi.restoreAllMocks());

describe("emergencyBucketCountsReport — counts + rates", () => {
  it("counts per bucket and stage, ages the oldest order, and rates against open work", async () => {
    const client = fakeClient(
      [EMERGENCY_BUCKET],
      [
        group(EMERGENCY_BUCKET_ID, OrderStatus.FILL_IN_PROGRESS, 6, 30),
        group(EMERGENCY_BUCKET_ID, OrderStatus.PV1_IN_PROGRESS, 2, 3.5),
      ],
      400
    );

    const result = await emergencyBucketCountsReport.run({ ...ctx, client: client as never }, {});

    expect(result.rows[0]).toEqual({
      bucketCode: "EMERGENCY",
      bucketName: "Emergency",
      currentStatus: OrderStatus.FILL_IN_PROGRESS,
      orderCount: 6,
      oldestReceivedAt: "2026-05-09T06:00:00.000Z",
      oldestAgeHours: 30,
      shareOfEmergencyBps: 7500, // 6 of 8
    });
    expect(result.rows[1]!.oldestAgeHours).toBe(3.5);
    expect(result.aggregates).toEqual({
      totalInEmergency: 8,
      openInEmergency: 8,
      openOrderCount: 400,
      emergencyShareOfOpenOrdersBps: 200, // 8 / 400 = 2%
      distinctBuckets: 1,
      distinctGroups: 2,
    });
  });

  it("keeps a terminal stray visible but out of the pressure ratio", async () => {
    // A CANCELLED order left parked in the emergency bucket is queue
    // clutter someone must disposition — it belongs in the rows. It
    // is not live work, so it must not inflate the ratio against a
    // denominator that excludes terminal orders.
    const client = fakeClient(
      [EMERGENCY_BUCKET],
      [
        group(EMERGENCY_BUCKET_ID, OrderStatus.FILL_IN_PROGRESS, 3, 5),
        group(EMERGENCY_BUCKET_ID, OrderStatus.CANCELLED, 1, 200),
      ],
      100
    );

    const result = await emergencyBucketCountsReport.run({ ...ctx, client: client as never }, {});

    expect(result.rows).toHaveLength(2);
    expect(result.aggregates["totalInEmergency"]).toBe(4);
    expect(result.aggregates["openInEmergency"]).toBe(3);
    expect(result.aggregates["emergencyShareOfOpenOrdersBps"]).toBe(300); // 3 / 100
  });

  it("returns no rows and zeroed aggregates when the org has no emergency bucket", async () => {
    const client = fakeClient([], [], 250);

    const result = await emergencyBucketCountsReport.run({ ...ctx, client: client as never }, {});

    expect(result.rows).toEqual([]);
    expect(result.aggregates).toEqual({
      totalInEmergency: 0,
      openInEmergency: 0,
      openOrderCount: 250,
      emergencyShareOfOpenOrdersBps: 0,
      distinctBuckets: 0,
      distinctGroups: 0,
    });
    // The empty bucket list still constrains the scan rather than
    // silently widening it to every bucket in the org.
    const args = client.order.groupBy.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where["currentBucketId"]).toEqual({ in: [] });
  });

  it("reports a zero rate rather than dividing by zero when nothing is open", async () => {
    const client = fakeClient(
      [EMERGENCY_BUCKET],
      [group(EMERGENCY_BUCKET_ID, OrderStatus.READY_TO_SHIP, 2, 1)],
      0
    );

    const result = await emergencyBucketCountsReport.run({ ...ctx, client: client as never }, {});

    expect(result.aggregates["emergencyShareOfOpenOrdersBps"]).toBe(0);
    expect(result.rows[0]!.shareOfEmergencyBps).toBe(10_000);
  });

  it("reports the snapshot instant on both window edges", async () => {
    const client = fakeClient([EMERGENCY_BUCKET], [], 10);

    const result = await emergencyBucketCountsReport.run({ ...ctx, client: client as never }, {});

    expect(result.window).toEqual({ from: NOW, to: NOW });
    expect(result.generatedAt).toEqual(NOW);
  });
});

describe("emergencyBucketCountsReport — sort order", () => {
  it("puts the biggest pile first", async () => {
    const client = fakeClient(
      [EMERGENCY_BUCKET, RUSH_BUCKET],
      [
        group(EMERGENCY_BUCKET_ID, OrderStatus.PV1_IN_PROGRESS, 2, 1),
        group(RUSH_BUCKET_ID, OrderStatus.FILL_IN_PROGRESS, 9, 1),
        group(EMERGENCY_BUCKET_ID, OrderStatus.TYPING_IN_PROGRESS, 5, 1),
      ],
      100
    );

    const result = await emergencyBucketCountsReport.run({ ...ctx, client: client as never }, {});

    expect(result.rows.map((r) => r.orderCount)).toEqual([9, 5, 2]);
    expect(result.aggregates["distinctBuckets"]).toBe(2);
  });

  it("breaks a count tie on bucket code, then on stage", async () => {
    const client = fakeClient(
      [EMERGENCY_BUCKET, RUSH_BUCKET],
      [
        group(EMERGENCY_BUCKET_ID, OrderStatus.PV1_IN_PROGRESS, 4, 1),
        group(EMERGENCY_BUCKET_ID, OrderStatus.FILL_IN_PROGRESS, 4, 1),
        group(RUSH_BUCKET_ID, OrderStatus.PV1_IN_PROGRESS, 4, 1),
      ],
      100
    );

    const result = await emergencyBucketCountsReport.run({ ...ctx, client: client as never }, {});

    expect(result.rows.map((r) => [r.bucketCode, r.currentStatus])).toEqual([
      ["AAA_RUSH", OrderStatus.PV1_IN_PROGRESS],
      ["EMERGENCY", OrderStatus.FILL_IN_PROGRESS],
      ["EMERGENCY", OrderStatus.PV1_IN_PROGRESS],
    ]);
  });
});

describe("emergencyBucketCountsReport — query shape", () => {
  it("selects buckets by kind rather than by the provisioned code", async () => {
    const client = fakeClient([EMERGENCY_BUCKET], [], 0);

    await emergencyBucketCountsReport.run({ ...ctx, client: client as never }, {});

    const args = client.bucket.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    // Matching on kind means an org's own escalation bucket is
    // counted the day it is created, not the day someone remembers
    // to update this report.
    expect(args.where).toEqual({ organizationId: ORG_ID, kind: BucketKind.EMERGENCY });
    expect(args.select).toEqual({ id: true, code: true, name: true });
  });

  it("groups the orders by bucket and stage with no date filter", async () => {
    const client = fakeClient([EMERGENCY_BUCKET], [], 0);

    await emergencyBucketCountsReport.run({ ...ctx, client: client as never }, {});

    const args = client.order.groupBy.mock.calls[0]![0] as {
      by: string[];
      where: Record<string, unknown>;
      _min: Record<string, unknown>;
    };
    expect(args.by).toEqual(["currentBucketId", "currentStatus"]);
    expect(args.where).toEqual({
      organizationId: ORG_ID,
      currentBucketId: { in: [EMERGENCY_BUCKET_ID] },
    });
    expect(args._min).toEqual({ receivedAt: true });
    // Point-in-time: an order dispositioned out of the bucket last
    // week is not in it now, so there is nothing to window on.
    expect(args.where).not.toHaveProperty("receivedAt");
  });

  it("counts only non-terminal orders as the denominator", async () => {
    const client = fakeClient([EMERGENCY_BUCKET], [], 0);

    await emergencyBucketCountsReport.run({ ...ctx, client: client as never }, {});

    const args = client.order.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({
      organizationId: ORG_ID,
      currentStatus: { notIn: [OrderStatus.SHIPPED, OrderStatus.CANCELLED] },
    });
  });
});

describe("emergencyBucketCountsReport — clinic scope", () => {
  it("narrows the orders and the denominator, but not the bucket lookup", async () => {
    const client = fakeClient([EMERGENCY_BUCKET], [], 0);

    await emergencyBucketCountsReport.run(
      { ...ctx, client: client as never, clinicId: CLINIC_ID },
      {}
    );

    const groupArgs = client.order.groupBy.mock.calls[0]![0] as { where: Record<string, unknown> };
    const countArgs = client.order.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    const bucketArgs = client.bucket.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(groupArgs.where).toMatchObject({ clinicId: CLINIC_ID });
    expect(countArgs.where).toMatchObject({ clinicId: CLINIC_ID });
    // The default emergency bucket is provisioned per SITE with a
    // null clinicId. Narrowing the bucket lookup by clinic would find
    // nothing and report a reassuring zero.
    expect(bucketArgs.where).not.toHaveProperty("clinicId");
  });

  it("omits the clinic filter from the order queries at org scope", async () => {
    const client = fakeClient([EMERGENCY_BUCKET], [], 0);

    await emergencyBucketCountsReport.run({ ...ctx, client: client as never }, {});

    const groupArgs = client.order.groupBy.mock.calls[0]![0] as { where: Record<string, unknown> };
    const countArgs = client.order.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(groupArgs.where).not.toHaveProperty("clinicId");
    expect(countArgs.where).not.toHaveProperty("clinicId");
  });
});
