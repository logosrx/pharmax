import { OrderStageIntervalKind } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STAGE_SLA_THRESHOLDS_MS,
  slaBreachReport,
  type SlaBreachReportParams,
} from "./sla-breach-report.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE = "00000000-0000-4000-8000-000000000003";

interface IntervalRow {
  id: string;
  orderId: string;
  siteId: string;
  kind: OrderStageIntervalKind;
  startedAt: Date;
  endedAt: Date | null;
}

function fakeClient(rows: ReadonlyArray<IntervalRow>) {
  return {
    // Declare an args param so `findMany.mock.calls[n][0]` is typed
    // as the captured argument (not an out-of-range tuple index).
    orderStageInterval: { findMany: vi.fn(async (_args: unknown) => rows) },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};
const ASOF = new Date("2026-06-01T00:00:00.000Z");

afterEach(() => vi.restoreAllMocks());

describe("slaBreachReport — closed intervals", () => {
  it("flags closed intervals that exceeded the threshold", async () => {
    const typingThreshold = DEFAULT_STAGE_SLA_THRESHOLDS_MS.TYPING_ACTIVE!;
    const startedAt = new Date("2026-05-10T10:00:00.000Z");
    const endedAt = new Date(startedAt.getTime() + typingThreshold + 5 * 60_000);
    const client = fakeClient([
      {
        id: "iv-1",
        orderId: "ord-1",
        siteId: SITE,
        kind: OrderStageIntervalKind.TYPING_ACTIVE,
        startedAt,
        endedAt,
      },
    ]);

    const result = await slaBreachReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: ASOF },
      window
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.active).toBe(false);
    expect(result.rows[0]?.overBy).toBe(5 * 60_000);
    expect(result.aggregates["breachCount"]).toBe(1);
    expect(result.aggregates["closedBreachCount"]).toBe(1);
    expect(result.aggregates["activeBreachCount"]).toBe(0);
  });

  it("ignores closed intervals within the threshold", async () => {
    const typingThreshold = DEFAULT_STAGE_SLA_THRESHOLDS_MS.TYPING_ACTIVE!;
    const startedAt = new Date("2026-05-10T10:00:00.000Z");
    const endedAt = new Date(startedAt.getTime() + typingThreshold - 60_000);
    const client = fakeClient([
      {
        id: "iv-ok",
        orderId: "ord-1",
        siteId: SITE,
        kind: OrderStageIntervalKind.TYPING_ACTIVE,
        startedAt,
        endedAt,
      },
    ]);
    const result = await slaBreachReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: ASOF },
      window
    );
    expect(result.rows).toHaveLength(0);
  });
});

describe("slaBreachReport — active (open) intervals", () => {
  it("flags open intervals exceeding the threshold measured to asOf", async () => {
    const threshold = DEFAULT_STAGE_SLA_THRESHOLDS_MS.PV1_ACTIVE!;
    const startedAt = new Date(ASOF.getTime() - threshold - 10 * 60_000);
    const client = fakeClient([
      {
        id: "iv-open",
        orderId: "ord-2",
        siteId: SITE,
        kind: OrderStageIntervalKind.PV1_ACTIVE,
        startedAt,
        endedAt: null,
      },
    ]);
    const result = await slaBreachReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: ASOF },
      window
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.active).toBe(true);
    expect(result.rows[0]?.overBy).toBe(10 * 60_000);
    expect(result.aggregates["activeBreachCount"]).toBe(1);
  });

  it("does NOT flag open intervals still within their threshold", async () => {
    const threshold = DEFAULT_STAGE_SLA_THRESHOLDS_MS.PV1_ACTIVE!;
    const startedAt = new Date(ASOF.getTime() - threshold + 60_000);
    const client = fakeClient([
      {
        id: "iv-open-ok",
        orderId: "ord-2",
        siteId: SITE,
        kind: OrderStageIntervalKind.PV1_ACTIVE,
        startedAt,
        endedAt: null,
      },
    ]);
    const result = await slaBreachReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: ASOF },
      window
    );
    expect(result.rows).toHaveLength(0);
  });
});

describe("slaBreachReport — threshold overrides", () => {
  it("uses caller-supplied overrides instead of defaults", async () => {
    const startedAt = new Date("2026-05-10T10:00:00.000Z");
    const endedAt = new Date(startedAt.getTime() + 10 * 60_000); // 10 min
    const client = fakeClient([
      {
        id: "iv-override",
        orderId: "ord-3",
        siteId: SITE,
        kind: OrderStageIntervalKind.TYPING_ACTIVE,
        startedAt,
        endedAt,
      },
    ]);
    const params: SlaBreachReportParams = {
      ...window,
      thresholdOverridesMs: { TYPING_ACTIVE: 5 * 60_000 }, // tighter threshold
    };
    const result = await slaBreachReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: ASOF },
      params
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.thresholdMs).toBe(5 * 60_000);
    expect(result.rows[0]?.overBy).toBe(5 * 60_000);
  });
});

describe("slaBreachReport — params validation", () => {
  it("rejects from > to", () => {
    const parsed = slaBreachReport.parametersSchema.safeParse({
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-05-31T00:00:00.000Z"),
    });
    expect(parsed.success).toBe(false);
  });
});

describe("slaBreachReport — query scoping", () => {
  it("narrows to the context clinic (via the order relation) when ctx.clinicId is set", async () => {
    const client = fakeClient([]);
    const CLINIC = "00000000-0000-4000-8000-000000000010";
    await slaBreachReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC, asOf: ASOF },
      window
    );
    const call = client.orderStageInterval.findMany.mock.calls[0]?.[0] as unknown as {
      where: Record<string, unknown>;
    };
    expect(call.where["organizationId"]).toBe(ORG_ID);
    // Regression: a clinic-scoped operator must NOT see other
    // clinics' intervals — the filter goes through the order
    // relation because intervals carry no clinicId column.
    expect(call.where["order"]).toEqual({ clinicId: CLINIC });
  });

  it("omits the clinic filter for org-wide contexts", async () => {
    const client = fakeClient([]);
    await slaBreachReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: ASOF },
      window
    );
    const call = client.orderStageInterval.findMany.mock.calls[0]?.[0] as unknown as {
      where: Record<string, unknown>;
    };
    expect(call.where["order"]).toBeUndefined();
  });

  it("includes open intervals that started BEFORE the window (active breaches must not vanish)", async () => {
    const client = fakeClient([]);
    await slaBreachReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: ASOF },
      window
    );
    const call = client.orderStageInterval.findMany.mock.calls[0]?.[0] as unknown as {
      where: { OR: ReadonlyArray<Record<string, unknown>> };
    };
    // Regression: filtering on startedAt alone hid an order stuck
    // in a stage since before the window — the oldest active
    // breach was invisible on a "today" report.
    expect(call.where.OR).toEqual([
      { startedAt: { gte: window.from, lte: window.to } },
      { endedAt: null, startedAt: { lte: window.to } },
    ]);
  });
});
