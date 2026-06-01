import { ShipmentCarrier, ShipmentStatus } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shipmentExceptionBreakdownReport } from "./shipment-exception-breakdown.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";

interface FakeGroup {
  carrier: ShipmentCarrier;
  status: ShipmentStatus;
  _count: { _all: number };
}

function fakeClient(groups: ReadonlyArray<FakeGroup>) {
  return {
    // Declare an args param so `groupBy.mock.calls[n][0]` is typed as
    // the captured argument (not an out-of-range empty-tuple index).
    shipment: { groupBy: vi.fn(async (_args: unknown) => groups) },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shipmentExceptionBreakdownReport — aggregates", () => {
  it("computes totals, exception count, delivered count, and exception rate (bps)", async () => {
    const client = fakeClient([
      { carrier: ShipmentCarrier.FEDEX, status: ShipmentStatus.DELIVERED, _count: { _all: 90 } },
      { carrier: ShipmentCarrier.FEDEX, status: ShipmentStatus.EXCEPTION, _count: { _all: 5 } },
      {
        carrier: ShipmentCarrier.UPS,
        status: ShipmentStatus.RETURN_TO_SENDER,
        _count: { _all: 3 },
      },
      { carrier: ShipmentCarrier.UPS, status: ShipmentStatus.FAILED_DELIVERY, _count: { _all: 2 } },
    ]);
    const result = await shipmentExceptionBreakdownReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(4);
    expect(result.aggregates).toEqual({
      totalCount: 100,
      exceptionCount: 10, // 5 EXCEPTION + 3 RTS + 2 FAILED
      deliveredCount: 90,
      distinctGroups: 4,
      exceptionRateBps: 1000, // 10% = 1000 bps
    });
    expect(result.window).toEqual(window);
  });

  it("returns zeroed aggregates on empty input", async () => {
    const client = fakeClient([]);
    const result = await shipmentExceptionBreakdownReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    expect(result.rows).toHaveLength(0);
    expect(result.aggregates["totalCount"]).toBe(0);
    expect(result.aggregates["exceptionRateBps"]).toBe(0);
  });

  it("sorts rows by carrier then status (deterministic CSV)", async () => {
    const client = fakeClient([
      { carrier: ShipmentCarrier.UPS, status: ShipmentStatus.DELIVERED, _count: { _all: 1 } },
      { carrier: ShipmentCarrier.FEDEX, status: ShipmentStatus.EXCEPTION, _count: { _all: 1 } },
      { carrier: ShipmentCarrier.FEDEX, status: ShipmentStatus.DELIVERED, _count: { _all: 1 } },
    ]);
    const result = await shipmentExceptionBreakdownReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    // FEDEX before UPS; within FEDEX, DELIVERED before EXCEPTION.
    expect(result.rows.map((r) => `${r.carrier}:${r.status}`)).toEqual([
      "FEDEX:DELIVERED",
      "FEDEX:EXCEPTION",
      "UPS:DELIVERED",
    ]);
  });
});

describe("shipmentExceptionBreakdownReport — query shape", () => {
  it("scopes by org + window and applies the optional carrier filter", async () => {
    const client = fakeClient([]);
    await shipmentExceptionBreakdownReport.run(
      { client: client as never, organizationId: ORG_ID },
      { ...window, carriers: [ShipmentCarrier.FEDEX] }
    );
    const call = client.shipment.groupBy.mock.calls[0]![0] as {
      by: ReadonlyArray<string>;
      where: Record<string, unknown>;
    };
    expect(call.by).toEqual(["carrier", "status"]);
    expect(call.where["organizationId"]).toBe(ORG_ID);
    expect(call.where["carrier"]).toEqual({ in: [ShipmentCarrier.FEDEX] });
    expect(call.where["createdAt"]).toEqual({ gte: window.from, lte: window.to });
  });

  it("omits the carrier filter when none supplied", async () => {
    const client = fakeClient([]);
    await shipmentExceptionBreakdownReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    const call = client.shipment.groupBy.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect("carrier" in call.where).toBe(false);
  });
});

describe("shipmentExceptionBreakdownReport — parameter schema", () => {
  it("rejects from > to", () => {
    const parsed = shipmentExceptionBreakdownReport.parametersSchema.safeParse({
      from: new Date("2026-06-01"),
      to: new Date("2026-05-01"),
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a valid window with carriers", () => {
    const parsed = shipmentExceptionBreakdownReport.parametersSchema.safeParse({
      from: new Date("2026-05-01"),
      to: new Date("2026-05-31"),
      carriers: ["FEDEX", "UPS"],
    });
    expect(parsed.success).toBe(true);
  });
});
