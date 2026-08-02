import { ShipmentCarrier } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shippingCostSummaryReport } from "./shipping-cost-summary.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";

interface CostedGroup {
  carrier: ShipmentCarrier;
  serviceLevel: string;
  _count: { _all: number };
  _sum: { postageRateCents: number | null };
  _avg: { postageRateCents: number | null };
  _min: { postageRateCents: number | null };
  _max: { postageRateCents: number | null };
}

interface UnknownGroup {
  carrier: ShipmentCarrier;
  serviceLevel: string;
  _count: { _all: number };
}

function fakeClient(costed: ReadonlyArray<CostedGroup>, unknown: ReadonlyArray<UnknownGroup>) {
  // First groupBy call = costed rows, second = NULL-cost rows.
  const groupBy = vi
    .fn(async (_args: unknown) => [] as unknown[])
    .mockResolvedValueOnce([...costed])
    .mockResolvedValueOnce([...unknown]);
  return { shipment: { groupBy } };
}

const window = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-31T23:59:59.999Z"),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shippingCostSummaryReport — aggregation", () => {
  it("merges costed and unknown-cost groups and computes spend aggregates", async () => {
    const client = fakeClient(
      [
        {
          carrier: ShipmentCarrier.FEDEX,
          serviceLevel: "FEDEX_GROUND",
          _count: { _all: 10 },
          _sum: { postageRateCents: 12_500 },
          _avg: { postageRateCents: 1_250 },
          _min: { postageRateCents: 900 },
          _max: { postageRateCents: 1_800 },
        },
      ],
      [
        // Same lane has 2 unknown-cost rows (pre-persistence).
        { carrier: ShipmentCarrier.FEDEX, serviceLevel: "FEDEX_GROUND", _count: { _all: 2 } },
        // A manual lane with ONLY unknown-cost rows still gets a row.
        { carrier: ShipmentCarrier.OTHER, serviceLevel: "MANUAL", _count: { _all: 3 } },
      ]
    );

    const result = await shippingCostSummaryReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(2);
    const fedex = result.rows.find((r) => r.carrier === ShipmentCarrier.FEDEX)!;
    expect(fedex).toMatchObject({
      shipmentCount: 10,
      unknownCostCount: 2,
      totalPostageCents: 12_500,
      avgPostageCents: 1_250,
      minPostageCents: 900,
      maxPostageCents: 1_800,
    });

    const manual = result.rows.find((r) => r.carrier === ShipmentCarrier.OTHER)!;
    expect(manual).toMatchObject({
      shipmentCount: 0,
      unknownCostCount: 3,
      totalPostageCents: 0,
    });

    expect(result.aggregates).toEqual({
      totalPostageCents: 12_500,
      costedCount: 10,
      unknownCostCount: 5,
      totalShipmentCount: 15,
      avgPostageCents: 1_250,
      distinctGroups: 2,
    });
  });

  it("returns zeroed aggregates on empty input", async () => {
    const client = fakeClient([], []);
    const result = await shippingCostSummaryReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    expect(result.rows).toHaveLength(0);
    expect(result.aggregates["totalPostageCents"]).toBe(0);
    expect(result.aggregates["avgPostageCents"]).toBe(0);
  });
});

describe("shippingCostSummaryReport — query shape", () => {
  it("splits costed vs NULL-cost and scopes by org + window + clinic", async () => {
    const CLINIC = "00000000-0000-4000-8000-000000000010";
    const client = fakeClient([], []);
    await shippingCostSummaryReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC },
      { ...window, carriers: [ShipmentCarrier.FEDEX] }
    );

    expect(client.shipment.groupBy).toHaveBeenCalledTimes(2);
    const costedWhere = (
      client.shipment.groupBy.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      }
    ).where;
    const unknownWhere = (
      client.shipment.groupBy.mock.calls[1]![0] as {
        where: Record<string, unknown>;
      }
    ).where;

    expect(costedWhere["organizationId"]).toBe(ORG_ID);
    expect(costedWhere["postageRateCents"]).toEqual({ not: null });
    expect(costedWhere["order"]).toEqual({ clinicId: CLINIC });
    expect(costedWhere["carrier"]).toEqual({ in: [ShipmentCarrier.FEDEX] });
    expect(costedWhere["createdAt"]).toEqual({ gte: window.from, lte: window.to });

    expect(unknownWhere["postageRateCents"]).toBeNull();
  });
});
