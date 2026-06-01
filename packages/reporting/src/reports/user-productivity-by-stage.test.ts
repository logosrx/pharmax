import { OrderStageIntervalKind } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { userProductivityByStageReport } from "./user-productivity-by-stage.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";

interface FakeInterval {
  actorUserId: string | null;
  kind: OrderStageIntervalKind;
  startedAt: Date;
  endedAt: Date | null;
  actorUser: { displayName: string } | null;
}

function fakeClient(intervals: ReadonlyArray<FakeInterval>) {
  return {
    orderStageInterval: { findMany: vi.fn(async () => intervals) },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

function iv(
  userId: string,
  name: string,
  kind: OrderStageIntervalKind,
  startISO: string,
  endISO: string
): FakeInterval {
  return {
    actorUserId: userId,
    kind,
    startedAt: new Date(startISO),
    endedAt: new Date(endISO),
    actorUser: { displayName: name },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("userProductivityByStageReport — aggregation", () => {
  it("averages active duration per (user, stage) and sums totals", async () => {
    const client = fakeClient([
      // Ana TYPING_ACTIVE: 60s and 120s → avg 90s, total 180s
      iv(
        USER_A,
        "Ana",
        OrderStageIntervalKind.TYPING_ACTIVE,
        "2026-05-10T10:00:00.000Z",
        "2026-05-10T10:01:00.000Z"
      ),
      iv(
        USER_A,
        "Ana",
        OrderStageIntervalKind.TYPING_ACTIVE,
        "2026-05-11T10:00:00.000Z",
        "2026-05-11T10:02:00.000Z"
      ),
      // Bob PV1_ACTIVE: 30s → avg 30s
      iv(
        USER_B,
        "Bob",
        OrderStageIntervalKind.PV1_ACTIVE,
        "2026-05-12T10:00:00.000Z",
        "2026-05-12T10:00:30.000Z"
      ),
    ]);
    const result = await userProductivityByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(2);
    const ana = result.rows.find((r) => r.actorUserId === USER_A)!;
    expect(ana).toMatchObject({
      actorUserName: "Ana",
      kind: OrderStageIntervalKind.TYPING_ACTIVE,
      completedCount: 2,
      avgActiveSeconds: 90,
      totalActiveSeconds: 180,
    });
    const bob = result.rows.find((r) => r.actorUserId === USER_B)!;
    expect(bob).toMatchObject({ completedCount: 1, avgActiveSeconds: 30, totalActiveSeconds: 30 });

    expect(result.aggregates).toEqual({
      totalIntervals: 3,
      distinctUsers: 2,
      distinctGroups: 2,
    });
  });

  it("skips negative durations (clock skew) without dragging the average", async () => {
    const client = fakeClient([
      iv(
        USER_A,
        "Ana",
        OrderStageIntervalKind.FILL_ACTIVE,
        "2026-05-10T10:00:00.000Z",
        "2026-05-10T10:01:00.000Z"
      ),
      // negative: ended before started
      iv(
        USER_A,
        "Ana",
        OrderStageIntervalKind.FILL_ACTIVE,
        "2026-05-11T10:05:00.000Z",
        "2026-05-11T10:00:00.000Z"
      ),
    ]);
    const result = await userProductivityByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ completedCount: 1, avgActiveSeconds: 60 });
  });

  it("sorts by user name then stage", async () => {
    const client = fakeClient([
      iv(
        USER_B,
        "Zoe",
        OrderStageIntervalKind.PV1_ACTIVE,
        "2026-05-12T10:00:00.000Z",
        "2026-05-12T10:00:30.000Z"
      ),
      iv(
        USER_A,
        "Ana",
        OrderStageIntervalKind.FILL_ACTIVE,
        "2026-05-10T10:00:00.000Z",
        "2026-05-10T10:01:00.000Z"
      ),
      iv(
        USER_A,
        "Ana",
        OrderStageIntervalKind.TYPING_ACTIVE,
        "2026-05-10T11:00:00.000Z",
        "2026-05-10T11:01:00.000Z"
      ),
    ]);
    const result = await userProductivityByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    // Ana before Zoe; within Ana, TYPING_ACTIVE before FILL_ACTIVE (enum order).
    expect(result.rows.map((r) => `${r.actorUserName}:${r.kind}`)).toEqual([
      "Ana:TYPING_ACTIVE",
      "Ana:FILL_ACTIVE",
      "Zoe:PV1_ACTIVE",
    ]);
  });
});

describe("userProductivityByStageReport — query shape", () => {
  it("filters to ACTIVE kinds, ended-in-window, non-null actor", async () => {
    const client = fakeClient([]);
    await userProductivityByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    const callArgs = client.orderStageInterval.findMany.mock.calls[0] as ReadonlyArray<unknown>;
    const call = callArgs[0] as { where: Record<string, unknown> };
    expect(call.where["organizationId"]).toBe(ORG_ID);
    expect(call.where["endedAt"]).toEqual({ gte: window.from, lte: window.to });
    expect(call.where["actorUserId"]).toEqual({ not: null });
    const kindFilter = call.where["kind"] as { in: ReadonlyArray<string> };
    expect(kindFilter.in).toContain(OrderStageIntervalKind.TYPING_ACTIVE);
    expect(kindFilter.in).not.toContain(OrderStageIntervalKind.WAIT_BEFORE_TYPING);
  });

  it("narrows to the supplied kinds when provided", async () => {
    const client = fakeClient([]);
    await userProductivityByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      { ...window, kinds: [OrderStageIntervalKind.PV1_ACTIVE] }
    );
    const callArgs = client.orderStageInterval.findMany.mock.calls[0] as ReadonlyArray<unknown>;
    const call = callArgs[0] as { where: { kind: { in: ReadonlyArray<string> } } };
    expect(call.where.kind.in).toEqual([OrderStageIntervalKind.PV1_ACTIVE]);
  });
});

describe("userProductivityByStageReport — schema", () => {
  it("rejects from > to and a WAIT_ kind", () => {
    expect(
      userProductivityByStageReport.parametersSchema.safeParse({
        from: new Date("2026-06-01"),
        to: new Date("2026-05-01"),
      }).success
    ).toBe(false);
    expect(
      userProductivityByStageReport.parametersSchema.safeParse({
        from: new Date("2026-05-01"),
        to: new Date("2026-05-31"),
        kinds: [OrderStageIntervalKind.WAIT_BEFORE_TYPING],
      }).success
    ).toBe(false);
  });
});
