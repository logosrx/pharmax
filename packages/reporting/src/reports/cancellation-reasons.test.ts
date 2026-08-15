import { CancellationDisposition, OrderStatus } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cancellationReasonsReport } from "./cancellation-reasons.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";

interface FakeGroup {
  dispositionReason: CancellationDisposition;
  cancelledFromStatus: OrderStatus;
  _count: { _all: number };
}

function group(
  dispositionReason: CancellationDisposition,
  cancelledFromStatus: OrderStatus,
  count: number
): FakeGroup {
  return { dispositionReason, cancelledFromStatus, _count: { _all: count } };
}

function fakeClient(groups: ReadonlyArray<FakeGroup>, ordersReceived: number) {
  return {
    orderCancellation: { groupBy: vi.fn(async (_args: unknown) => groups) },
    order: { count: vi.fn(async (_args: unknown) => ordersReceived) },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

afterEach(() => vi.restoreAllMocks());

describe("cancellationReasonsReport — counts + rates", () => {
  it("pivots reason against exit stage and rates cancellations against intake", async () => {
    const client = fakeClient(
      [
        group(
          CancellationDisposition.INSURANCE_DENIAL,
          OrderStatus.PV1_IN_PROGRESS,
          // The shape the report exists to expose: the same reason
          // costs far more when it fires late.
          12
        ),
        group(CancellationDisposition.INSURANCE_DENIAL, OrderStatus.RECEIVED, 5),
        group(CancellationDisposition.DUPLICATE_ORDER, OrderStatus.RECEIVED, 3),
      ],
      400
    );

    const result = await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toEqual({
      dispositionReason: CancellationDisposition.INSURANCE_DENIAL,
      cancelledFromStatus: OrderStatus.PV1_IN_PROGRESS,
      cancellationCount: 12,
      shareOfCancellationsBps: 6000, // 12 of 20
    });
    expect(result.aggregates).toEqual({
      totalCancellations: 20,
      ordersReceivedInWindow: 400,
      cancellationRateBps: 500, // 20 / 400 = 5%
      distinctReasons: 2,
      distinctGroups: 3,
    });
  });

  it("counts distinct reasons rather than rows when one reason spans stages", async () => {
    const client = fakeClient(
      [
        group(CancellationDisposition.PATIENT_REQUEST, OrderStatus.RECEIVED, 4),
        group(CancellationDisposition.PATIENT_REQUEST, OrderStatus.FILL_IN_PROGRESS, 4),
        group(CancellationDisposition.PATIENT_REQUEST, OrderStatus.READY_TO_SHIP, 2),
      ],
      100
    );

    const result = await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.aggregates["distinctReasons"]).toBe(1);
    expect(result.aggregates["distinctGroups"]).toBe(3);
  });

  it("returns no rows and zeroed aggregates for an empty window", async () => {
    const client = fakeClient([], 0);

    const result = await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toEqual([]);
    expect(result.aggregates).toEqual({
      totalCancellations: 0,
      ordersReceivedInWindow: 0,
      cancellationRateBps: 0,
      distinctReasons: 0,
      distinctGroups: 0,
    });
  });

  it("reports a zero rate rather than dividing by zero when nothing was received", async () => {
    // Possible in a narrow window: an order received last month is
    // cancelled today, so the numerator is non-zero while the
    // window's intake is zero.
    const client = fakeClient([group(CancellationDisposition.OTHER, OrderStatus.ON_HOLD, 2)], 0);

    const result = await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.aggregates["totalCancellations"]).toBe(2);
    expect(result.aggregates["cancellationRateBps"]).toBe(0);
    expect(result.rows[0]!.shareOfCancellationsBps).toBe(10_000);
  });
});

describe("cancellationReasonsReport — sort order", () => {
  it("puts the costliest pairing first", async () => {
    const client = fakeClient(
      [
        group(CancellationDisposition.DATA_ENTRY_ERROR, OrderStatus.RECEIVED, 1),
        group(CancellationDisposition.INVENTORY_UNAVAILABLE, OrderStatus.FILL_IN_PROGRESS, 9),
        group(CancellationDisposition.CLINIC_REQUEST, OrderStatus.TYPING_IN_PROGRESS, 4),
      ],
      50
    );

    const result = await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => r.cancellationCount)).toEqual([9, 4, 1]);
  });

  it("breaks a count tie on reason, then on exit stage", async () => {
    const client = fakeClient(
      [
        group(CancellationDisposition.PROVIDER_REQUEST, OrderStatus.READY_TO_SHIP, 3),
        group(CancellationDisposition.CLINIC_REQUEST, OrderStatus.RECEIVED, 3),
        group(CancellationDisposition.PROVIDER_REQUEST, OrderStatus.PV1_IN_PROGRESS, 3),
      ],
      50
    );

    const result = await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => [r.dispositionReason, r.cancelledFromStatus])).toEqual([
      [CancellationDisposition.CLINIC_REQUEST, OrderStatus.RECEIVED],
      [CancellationDisposition.PROVIDER_REQUEST, OrderStatus.PV1_IN_PROGRESS],
      [CancellationDisposition.PROVIDER_REQUEST, OrderStatus.READY_TO_SHIP],
    ]);
  });
});

describe("cancellationReasonsReport — query shape", () => {
  it("pivots on reason + exit stage and windows on cancelledAt", async () => {
    const client = fakeClient([], 0);

    await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    const args = client.orderCancellation.groupBy.mock.calls[0]![0] as {
      by: string[];
      where: Record<string, unknown>;
    };
    expect(args.by).toEqual(["dispositionReason", "cancelledFromStatus"]);
    expect(args.where).toMatchObject({
      organizationId: ORG_ID,
      // cancelledAt, not the order's receivedAt: the question is
      // what was cancelled in the window, not which intake cohort.
      cancelledAt: { gte: window.from, lte: window.to },
    });
    // Operator free-text stays out of the query entirely.
    expect(JSON.stringify(args)).not.toContain("dispositionReasonText");
  });

  it("counts orders received in the same window as the denominator", async () => {
    const client = fakeClient([], 0);

    await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    const args = client.order.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({
      organizationId: ORG_ID,
      receivedAt: { gte: window.from, lte: window.to },
    });
  });

  it("narrows to the requested dispositions when the operator picks a subset", async () => {
    const client = fakeClient([], 0);

    await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID },
      { ...window, dispositions: [CancellationDisposition.INSURANCE_DENIAL] }
    );

    const args = client.orderCancellation.groupBy.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(args.where["dispositionReason"]).toEqual({
      in: [CancellationDisposition.INSURANCE_DENIAL],
    });
  });

  it("omits the disposition filter when an empty selection is submitted", async () => {
    const client = fakeClient([], 0);

    await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID },
      { ...window, dispositions: [] }
    );

    const args = client.orderCancellation.groupBy.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(args.where).not.toHaveProperty("dispositionReason");
  });
});

describe("cancellationReasonsReport — clinic scope", () => {
  it("narrows BOTH the cancellations and the intake denominator", async () => {
    const client = fakeClient([], 0);

    await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_ID },
      window
    );

    // Scoping only the numerator would divide one clinic's
    // cancellations by the whole org's intake and report a rate far
    // below reality.
    const groupArgs = client.orderCancellation.groupBy.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    const countArgs = client.order.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(groupArgs.where).toMatchObject({ order: { clinicId: CLINIC_ID } });
    expect(countArgs.where).toMatchObject({ clinicId: CLINIC_ID });
  });

  it("omits the clinic filter from both queries at org scope", async () => {
    const client = fakeClient([], 0);

    await cancellationReasonsReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    const groupArgs = client.orderCancellation.groupBy.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    const countArgs = client.order.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(groupArgs.where).not.toHaveProperty("order");
    expect(countArgs.where).not.toHaveProperty("clinicId");
  });
});
