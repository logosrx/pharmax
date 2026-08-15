import { OrderStageIntervalKind } from "@pharmax/database";
import { DEFAULT_STAGE_SLA_THRESHOLDS_MS } from "@pharmax/sla";
import { afterEach, describe, expect, it, vi } from "vitest";

import { waitTimeByStageReport } from "./wait-time-by-stage.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";

const BASE = new Date("2026-05-10T12:00:00.000Z");

interface FakeInterval {
  kind: OrderStageIntervalKind;
  startedAt: Date;
  endedAt: Date | null;
}

/** Build a closed interval of `minutes` duration. */
function wait(kind: OrderStageIntervalKind, minutes: number): FakeInterval {
  return {
    kind,
    startedAt: BASE,
    endedAt: new Date(BASE.getTime() + minutes * 60_000),
  };
}

function fakeClient(intervals: ReadonlyArray<FakeInterval>) {
  return {
    orderStageInterval: { findMany: vi.fn(async (_args: unknown) => intervals) },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

afterEach(() => vi.restoreAllMocks());

describe("waitTimeByStageReport — distribution per stage", () => {
  it("reports mean, median, p95, max and total for a stage", async () => {
    // Ten waits before PV1: nine quick, one very slow. This is the
    // shape the report exists to expose — the mean looks acceptable
    // while the tail is where every breach comes from.
    const client = fakeClient([
      ...Array.from({ length: 9 }, () => wait(OrderStageIntervalKind.WAIT_BEFORE_PV1, 2)),
      wait(OrderStageIntervalKind.WAIT_BEFORE_PV1, 200),
    ]);

    const result = await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.completedCount).toBe(10);
    // (9×2 + 200) / 10 = 21.8 min = 1308s
    expect(row.avgWaitSeconds).toBe(1308);
    // Nearest-rank p50 over 10 samples is the 5th → 2 min.
    expect(row.p50WaitSeconds).toBe(120);
    // Nearest-rank p95 over 10 samples is the 10th → 200 min.
    expect(row.p95WaitSeconds).toBe(12_000);
    expect(row.maxWaitSeconds).toBe(12_000);
    expect(row.totalWaitSeconds).toBe(9 * 120 + 12_000);
  });

  it("shows the median far below the mean when the tail is long", async () => {
    // The explicit justification for carrying percentiles: an
    // average alone would report this queue as ~22 minutes and hide
    // that the typical order waits 2.
    const client = fakeClient([
      ...Array.from({ length: 9 }, () => wait(OrderStageIntervalKind.WAIT_BEFORE_PV1, 2)),
      wait(OrderStageIntervalKind.WAIT_BEFORE_PV1, 200),
    ]);

    const result = await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    const row = result.rows[0]!;
    expect(row.p50WaitSeconds).toBeLessThan(row.avgWaitSeconds);
    expect(row.p95WaitSeconds).toBeGreaterThan(row.avgWaitSeconds);
  });

  it("orders rows by workflow position, not by severity", async () => {
    const client = fakeClient([
      wait(OrderStageIntervalKind.WAIT_BEFORE_SHIPPING, 5),
      wait(OrderStageIntervalKind.WAIT_BEFORE_TYPING, 500),
      wait(OrderStageIntervalKind.WAIT_BEFORE_FILL, 5),
    ]);

    const result = await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows.map((r) => r.kind)).toEqual([
      OrderStageIntervalKind.WAIT_BEFORE_TYPING,
      OrderStageIntervalKind.WAIT_BEFORE_FILL,
      OrderStageIntervalKind.WAIT_BEFORE_SHIPPING,
    ]);
  });

  it("handles a single sample without dividing by zero or mis-ranking", async () => {
    const client = fakeClient([wait(OrderStageIntervalKind.WAIT_BEFORE_FILL, 10)]);

    const result = await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    const row = result.rows[0]!;
    expect(row.completedCount).toBe(1);
    expect(row.avgWaitSeconds).toBe(600);
    expect(row.p50WaitSeconds).toBe(600);
    expect(row.p95WaitSeconds).toBe(600);
    expect(row.maxWaitSeconds).toBe(600);
  });

  it("returns no rows and zeroed aggregates for an empty window", async () => {
    const client = fakeClient([]);

    const result = await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toEqual([]);
    expect(result.aggregates).toEqual({
      totalWaits: 0,
      totalWaitSeconds: 0,
      overallOverThresholdCount: 0,
      overallOverThresholdRateBps: 0,
      distinctStages: 0,
    });
  });
});

describe("waitTimeByStageReport — SLA thresholds", () => {
  it("rates each stage against the canonical @pharmax/sla threshold", async () => {
    // WAIT_BEFORE_PV1's threshold is 30 minutes. Read from the
    // canonical map rather than hardcoded here, so retuning the
    // threshold does not silently invalidate this test's premise.
    const thresholdMs = DEFAULT_STAGE_SLA_THRESHOLDS_MS[OrderStageIntervalKind.WAIT_BEFORE_PV1]!;
    const thresholdMinutes = thresholdMs / 60_000;

    const client = fakeClient([
      wait(OrderStageIntervalKind.WAIT_BEFORE_PV1, thresholdMinutes + 1), // over
      wait(OrderStageIntervalKind.WAIT_BEFORE_PV1, thresholdMinutes + 5), // over
      wait(OrderStageIntervalKind.WAIT_BEFORE_PV1, thresholdMinutes - 1), // under
      wait(OrderStageIntervalKind.WAIT_BEFORE_PV1, 1), // under
    ]);

    const result = await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    const row = result.rows[0]!;
    expect(row.thresholdSeconds).toBe(Math.round(thresholdMs / 1000));
    expect(row.overThresholdCount).toBe(2);
    expect(row.overThresholdRateBps).toBe(5000); // 2 of 4
  });

  it("treats a wait exactly at the threshold as within SLA", async () => {
    // Matches `classifySlaStatus`'s inclusive boundary handling: at
    // the deadline is not yet breached.
    const thresholdMs = DEFAULT_STAGE_SLA_THRESHOLDS_MS[OrderStageIntervalKind.WAIT_BEFORE_FILL]!;
    const client = fakeClient([
      wait(OrderStageIntervalKind.WAIT_BEFORE_FILL, thresholdMs / 60_000),
    ]);

    const result = await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows[0]!.overThresholdCount).toBe(0);
  });

  it("rolls over-threshold counts into the aggregates across stages", async () => {
    const pv1Threshold =
      DEFAULT_STAGE_SLA_THRESHOLDS_MS[OrderStageIntervalKind.WAIT_BEFORE_PV1]! / 60_000;
    const fillThreshold =
      DEFAULT_STAGE_SLA_THRESHOLDS_MS[OrderStageIntervalKind.WAIT_BEFORE_FILL]! / 60_000;

    const client = fakeClient([
      wait(OrderStageIntervalKind.WAIT_BEFORE_PV1, pv1Threshold + 10),
      wait(OrderStageIntervalKind.WAIT_BEFORE_PV1, 1),
      wait(OrderStageIntervalKind.WAIT_BEFORE_FILL, fillThreshold + 10),
      wait(OrderStageIntervalKind.WAIT_BEFORE_FILL, 1),
    ]);

    const result = await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.aggregates["totalWaits"]).toBe(4);
    expect(result.aggregates["overallOverThresholdCount"]).toBe(2);
    expect(result.aggregates["overallOverThresholdRateBps"]).toBe(5000);
    expect(result.aggregates["distinctStages"]).toBe(2);
  });
});

describe("waitTimeByStageReport — bad data", () => {
  it("drops negative durations instead of letting them pull the mean down", async () => {
    const client = fakeClient([
      wait(OrderStageIntervalKind.WAIT_BEFORE_TYPING, 10),
      // Clock skew / bad data: ended before it started.
      {
        kind: OrderStageIntervalKind.WAIT_BEFORE_TYPING,
        startedAt: BASE,
        endedAt: new Date(BASE.getTime() - 60_000),
      },
    ]);

    const result = await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows[0]!.completedCount).toBe(1);
    expect(result.rows[0]!.avgWaitSeconds).toBe(600);
  });

  it("skips a row whose endedAt is null rather than counting it as zero", async () => {
    // The query filters these out, but the selected type is nullable
    // and a zero-length wait would understate every average.
    const client = fakeClient([
      wait(OrderStageIntervalKind.WAIT_BEFORE_TYPING, 10),
      { kind: OrderStageIntervalKind.WAIT_BEFORE_TYPING, startedAt: BASE, endedAt: null },
    ]);

    const result = await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows[0]!.completedCount).toBe(1);
  });
});

describe("waitTimeByStageReport — query shape", () => {
  it("scopes to the org, the five wait kinds, and closed intervals in-window", async () => {
    const client = fakeClient([]);

    await waitTimeByStageReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = client.orderStageInterval.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.where).toMatchObject({
      organizationId: ORG_ID,
      // Windowing on endedAt is what excludes open (in-progress)
      // waits, whose partial duration would skew every average down.
      endedAt: { gte: window.from, lte: window.to },
    });
    expect(args.where["kind"]).toEqual({
      in: [
        OrderStageIntervalKind.WAIT_BEFORE_TYPING,
        OrderStageIntervalKind.WAIT_BEFORE_PV1,
        OrderStageIntervalKind.WAIT_BEFORE_FILL,
        OrderStageIntervalKind.WAIT_BEFORE_FINAL_VERIFICATION,
        OrderStageIntervalKind.WAIT_BEFORE_SHIPPING,
      ],
    });
    // No actor join: a queue wait has no actor, and selecting one
    // would be a pointless join on every row.
    expect(args.select).toEqual({ kind: true, startedAt: true, endedAt: true });
  });

  it("narrows to the requested kinds when the operator picks a subset", async () => {
    const client = fakeClient([]);

    await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      {
        ...window,
        kinds: [OrderStageIntervalKind.WAIT_BEFORE_FILL],
      }
    );

    const args = client.orderStageInterval.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(args.where["kind"]).toEqual({
      in: [OrderStageIntervalKind.WAIT_BEFORE_FILL],
    });
  });

  it("falls back to all five kinds when an empty selection is submitted", async () => {
    const client = fakeClient([]);

    await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      {
        ...window,
        kinds: [],
      }
    );

    const args = client.orderStageInterval.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect((args.where["kind"] as { in: unknown[] }).in).toHaveLength(5);
  });
});

describe("waitTimeByStageReport — clinic scope", () => {
  it("narrows through the order relation for a clinic-scoped operator", async () => {
    const client = fakeClient([]);

    await waitTimeByStageReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_ID },
      window
    );

    const args = client.orderStageInterval.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(args.where).toMatchObject({ order: { clinicId: CLINIC_ID } });
  });

  it("omits the clinic filter at org scope", async () => {
    const client = fakeClient([]);

    await waitTimeByStageReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = client.orderStageInterval.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(args.where).not.toHaveProperty("order");
  });
});
