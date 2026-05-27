import { OrderStatus } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { orderVolumeByStageReport } from "./order-volume-by-stage.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_A = "0c0c0c0c-aaaa-4c0c-8c0c-aaaaaaaaaaaa";
const CLINIC_B = "0c0c0c0c-bbbb-4c0c-8c0c-bbbbbbbbbbbb";

interface FakeGroup {
  clinicId: string;
  currentStatus: OrderStatus;
  _count: { _all: number };
}

function fakeClient(groups: ReadonlyArray<FakeGroup>) {
  return {
    order: { groupBy: vi.fn(async () => groups) },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("orderVolumeByStageReport — aggregates", () => {
  it("returns per-(clinic, status) counts + totalCount + distinctGroups", async () => {
    const client = fakeClient([
      { clinicId: CLINIC_A, currentStatus: OrderStatus.TYPING_IN_PROGRESS, _count: { _all: 5 } },
      { clinicId: CLINIC_A, currentStatus: OrderStatus.PV1_IN_PROGRESS, _count: { _all: 3 } },
      { clinicId: CLINIC_B, currentStatus: OrderStatus.SHIPPED, _count: { _all: 12 } },
    ]);
    const result = await orderVolumeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(3);
    expect(result.aggregates).toEqual({ totalCount: 20, distinctGroups: 3 });
    expect(result.window).toEqual(window);
  });

  it("returns empty rows + zero aggregates on empty input", async () => {
    const client = fakeClient([]);
    const result = await orderVolumeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    expect(result.rows).toHaveLength(0);
    expect(result.aggregates["totalCount"]).toBe(0);
    expect(result.aggregates["distinctGroups"]).toBe(0);
  });
});

describe("orderVolumeByStageReport — query shape", () => {
  it("scopes by organizationId + date range and projects the required columns", async () => {
    const client = fakeClient([]);
    await orderVolumeByStageReport.run({ client: client as never, organizationId: ORG_ID }, window);
    const calls = client.order.groupBy.mock.calls as unknown as Array<
      [{ by: string[]; where: Record<string, unknown> }]
    >;
    expect(calls[0]![0].by).toEqual(["clinicId", "currentStatus"]);
    expect(calls[0]![0].where["organizationId"]).toBe(ORG_ID);
    expect(calls[0]![0].where["receivedAt"]).toEqual({ gte: window.from, lte: window.to });
  });

  it("includes clinicId in WHERE when ctx.clinicId is set", async () => {
    const client = fakeClient([]);
    await orderVolumeByStageReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_A },
      window
    );
    const calls = client.order.groupBy.mock.calls as unknown as Array<
      [{ where: Record<string, unknown> }]
    >;
    expect(calls[0]![0].where["clinicId"]).toBe(CLINIC_A);
  });

  it("applies statuses filter when provided", async () => {
    const client = fakeClient([]);
    await orderVolumeByStageReport.run(
      { client: client as never, organizationId: ORG_ID },
      { ...window, statuses: [OrderStatus.PV1_IN_PROGRESS, OrderStatus.FILL_IN_PROGRESS] }
    );
    const calls = client.order.groupBy.mock.calls as unknown as Array<
      [{ where: Record<string, unknown> }]
    >;
    expect(calls[0]![0].where["currentStatus"]).toEqual({
      in: [OrderStatus.PV1_IN_PROGRESS, OrderStatus.FILL_IN_PROGRESS],
    });
  });
});

describe("orderVolumeByStageReport — params validation", () => {
  it("rejects from > to", () => {
    const parsed = orderVolumeByStageReport.parametersSchema.safeParse({
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-05-31T00:00:00.000Z"),
    });
    expect(parsed.success).toBe(false);
  });
});
