import { OrderStatus, ReopenReason } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reworkRateReport } from "./rework-rate.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";

interface FakeGroup {
  reason: ReopenReason;
  reopenedFromStatus: OrderStatus;
  reopenToStatus: OrderStatus;
  _count: { _all: number };
}

function loop(
  reason: ReopenReason,
  reopenedFromStatus: OrderStatus,
  reopenToStatus: OrderStatus,
  count: number
): FakeGroup {
  return { reason, reopenedFromStatus, reopenToStatus, _count: { _all: count } };
}

/**
 * The report issues two `groupBy` calls against the same delegate —
 * one pivoted on (reason, from, to) and one on `orderId` for the
 * distinct-order count. The stub answers on `by` so each call gets
 * the shape it asked for.
 */
function fakeClient(
  groups: ReadonlyArray<FakeGroup>,
  reopenedOrderIds: ReadonlyArray<string>,
  ordersReceived: number
) {
  return {
    orderCorrectionReopen: {
      groupBy: vi.fn(async (args: { by: ReadonlyArray<string> }) =>
        args.by[0] === "orderId" ? reopenedOrderIds.map((orderId) => ({ orderId })) : groups
      ),
    },
    order: { count: vi.fn(async (_args: unknown) => ordersReceived) },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

const RECEIVED = OrderStatus.RECEIVED;
const TYPING = OrderStatus.TYPING_IN_PROGRESS;
const TYPED = OrderStatus.TYPED_READY_FOR_PV1;
const PV1 = OrderStatus.PV1_IN_PROGRESS;
const FILL = OrderStatus.FILL_IN_PROGRESS;

afterEach(() => vi.restoreAllMocks());

describe("reworkRateReport — counts + rates", () => {
  it("reports each loop's share and rates distinct reworked orders against intake", async () => {
    const client = fakeClient(
      [
        loop(ReopenReason.FILL_REDO, FILL, TYPING, 6),
        loop(ReopenReason.TYPING_CORRECTION, TYPED, TYPING, 2),
      ],
      ["order-a", "order-b", "order-c", "order-d", "order-e"],
      500
    );

    const result = await reworkRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows[0]).toEqual({
      reason: ReopenReason.FILL_REDO,
      reopenedFromStatus: FILL,
      reopenToStatus: TYPING,
      reopenCount: 6,
      shareOfReopensBps: 7500, // 6 of 8
    });
    expect(result.aggregates).toEqual({
      totalReopens: 8,
      ordersReopened: 5,
      // 8 events across 5 orders: three were sent back more than once.
      repeatReopenCount: 3,
      ordersReceivedInWindow: 500,
      reworkRateBps: 100, // 5 orders / 500 = 1%
      distinctGroups: 2,
    });
  });

  it("rates on distinct orders so one order bouncing repeatedly cannot inflate it", async () => {
    // Eight reopen events, all of them the same order. The floor
    // experienced one order needing rework, not eight.
    const client = fakeClient([loop(ReopenReason.PV1_REWORK, PV1, TYPING, 8)], ["order-a"], 100);

    const result = await reworkRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.aggregates["totalReopens"]).toBe(8);
    expect(result.aggregates["ordersReopened"]).toBe(1);
    expect(result.aggregates["repeatReopenCount"]).toBe(7);
    expect(result.aggregates["reworkRateBps"]).toBe(100); // 1 / 100, not 8 / 100
  });

  it("returns no rows and zeroed aggregates for an empty window", async () => {
    const client = fakeClient([], [], 0);

    const result = await reworkRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toEqual([]);
    expect(result.aggregates).toEqual({
      totalReopens: 0,
      ordersReopened: 0,
      repeatReopenCount: 0,
      ordersReceivedInWindow: 0,
      reworkRateBps: 0,
      distinctGroups: 0,
    });
  });

  it("reports a zero rate rather than dividing by zero when nothing was received", async () => {
    const client = fakeClient(
      [loop(ReopenReason.SUPERVISOR_DIRECTED, PV1, RECEIVED, 1)],
      ["order-a"],
      0
    );

    const result = await reworkRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.aggregates["reworkRateBps"]).toBe(0);
    expect(result.rows[0]!.shareOfReopensBps).toBe(10_000);
  });
});

describe("reworkRateReport — sort order", () => {
  it("puts the most frequent loop first", async () => {
    const client = fakeClient(
      [
        loop(ReopenReason.LABEL_REWORK, FILL, FILL, 1),
        loop(ReopenReason.FILL_REDO, FILL, TYPING, 9),
        loop(ReopenReason.TYPING_CORRECTION, TYPED, TYPING, 4),
      ],
      ["a"],
      50
    );

    const result = await reworkRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => r.reopenCount)).toEqual([9, 4, 1]);
  });

  it("breaks a count tie on reason, then on the from stage, then on the to stage", async () => {
    const client = fakeClient(
      [
        loop(ReopenReason.PV1_REWORK, PV1, TYPING, 3),
        loop(ReopenReason.FILL_REDO, FILL, TYPING, 3),
        loop(ReopenReason.PV1_REWORK, PV1, RECEIVED, 3),
      ],
      ["a"],
      50
    );

    const result = await reworkRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => [r.reason, r.reopenedFromStatus, r.reopenToStatus])).toEqual([
      [ReopenReason.FILL_REDO, FILL, TYPING],
      [ReopenReason.PV1_REWORK, PV1, RECEIVED],
      [ReopenReason.PV1_REWORK, PV1, TYPING],
    ]);
  });
});

describe("reworkRateReport — query shape", () => {
  it("pivots on reason + both stages and windows on reopenedAt", async () => {
    const client = fakeClient([], [], 0);

    await reworkRateReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = client.orderCorrectionReopen.groupBy.mock.calls[0]![0] as unknown as {
      by: string[];
      where: Record<string, unknown>;
    };
    expect(args.by).toEqual(["reason", "reopenedFromStatus", "reopenToStatus"]);
    expect(args.where).toMatchObject({
      organizationId: ORG_ID,
      reopenedAt: { gte: window.from, lte: window.to },
    });
    // Operator free-text stays out of the query entirely.
    expect(JSON.stringify(args)).not.toContain("reasonText");
  });

  it("counts distinct orders with the SAME filter as the event pivot", async () => {
    const client = fakeClient([], [], 0);

    await reworkRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      { ...window, reasons: [ReopenReason.FILL_REDO] }
    );

    const [eventCall, orderCall] = client.orderCorrectionReopen.groupBy.mock.calls;
    const eventArgs = eventCall![0] as unknown as { where: Record<string, unknown> };
    const orderArgs = orderCall![0] as unknown as { by: string[]; where: Record<string, unknown> };
    expect(orderArgs.by).toEqual(["orderId"]);
    // A drifting filter here would rate a filtered numerator against
    // an unfiltered distinct-order count.
    expect(orderArgs.where).toEqual(eventArgs.where);
    expect(orderArgs.where["reason"]).toEqual({ in: [ReopenReason.FILL_REDO] });
  });

  it("counts orders received in the same window as the denominator", async () => {
    const client = fakeClient([], [], 0);

    await reworkRateReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = client.order.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({
      organizationId: ORG_ID,
      receivedAt: { gte: window.from, lte: window.to },
    });
  });

  it("omits the reason filter when an empty selection is submitted", async () => {
    const client = fakeClient([], [], 0);

    await reworkRateReport.run(
      { client: client as never, organizationId: ORG_ID },
      { ...window, reasons: [] }
    );

    const args = client.orderCorrectionReopen.groupBy.mock.calls[0]![0] as unknown as {
      where: Record<string, unknown>;
    };
    expect(args.where).not.toHaveProperty("reason");
  });
});

describe("reworkRateReport — clinic scope", () => {
  it("narrows the reopen pivot, the distinct-order count, and the denominator", async () => {
    const client = fakeClient([], [], 0);

    await reworkRateReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_ID },
      window
    );

    const [eventCall, orderCall] = client.orderCorrectionReopen.groupBy.mock.calls;
    const eventArgs = eventCall![0] as unknown as { where: Record<string, unknown> };
    const orderArgs = orderCall![0] as unknown as { where: Record<string, unknown> };
    const countArgs = client.order.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(eventArgs.where).toMatchObject({ order: { clinicId: CLINIC_ID } });
    expect(orderArgs.where).toMatchObject({ order: { clinicId: CLINIC_ID } });
    expect(countArgs.where).toMatchObject({ clinicId: CLINIC_ID });
  });

  it("omits the clinic filter from every query at org scope", async () => {
    const client = fakeClient([], [], 0);

    await reworkRateReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const eventArgs = client.orderCorrectionReopen.groupBy.mock.calls[0]![0] as unknown as {
      where: Record<string, unknown>;
    };
    const countArgs = client.order.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(eventArgs.where).not.toHaveProperty("order");
    expect(countArgs.where).not.toHaveProperty("clinicId");
  });
});
