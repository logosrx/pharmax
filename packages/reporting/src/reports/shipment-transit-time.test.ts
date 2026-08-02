import { ShipmentCarrier, ShipmentStatus } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shipmentTransitTimeReport } from "./shipment-transit-time.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";

interface FakeShipment {
  carrier: ShipmentCarrier;
  serviceLevel: string;
  confirmedAt: Date | null;
  lastTrackingEventAt: Date | null;
  estimatedDeliveryAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  transitSeconds: number | null;
}

function fakeClient(shipments: ReadonlyArray<FakeShipment>) {
  return {
    shipment: { findMany: vi.fn(async (_args: unknown) => shipments) },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

function delivered(input: {
  carrier?: ShipmentCarrier;
  serviceLevel?: string;
  confirmedAt: string;
  deliveredAt: string;
  estimatedAt?: string | null;
  /** Persisted pickup→delivery pair (post-migration rows). */
  transit?: { pickedUpAt: string; deliveredAt: string };
}): FakeShipment {
  const transitSeconds =
    input.transit === undefined
      ? null
      : Math.round(
          (new Date(input.transit.deliveredAt).getTime() -
            new Date(input.transit.pickedUpAt).getTime()) /
            1000
        );
  return {
    carrier: input.carrier ?? ShipmentCarrier.FEDEX,
    serviceLevel: input.serviceLevel ?? "FEDEX_GROUND",
    confirmedAt: new Date(input.confirmedAt),
    lastTrackingEventAt: new Date(input.deliveredAt),
    estimatedDeliveryAt:
      input.estimatedAt === undefined || input.estimatedAt === null
        ? null
        : new Date(input.estimatedAt),
    pickedUpAt: input.transit === undefined ? null : new Date(input.transit.pickedUpAt),
    deliveredAt: input.transit === undefined ? null : new Date(input.transit.deliveredAt),
    transitSeconds,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shipmentTransitTimeReport — transit math", () => {
  it("computes avg / p50 / p95 transit hours per carrier + service level", async () => {
    const client = fakeClient([
      // 24h, 48h, 72h → avg 48, p50 48, p95 72 (nearest-rank)
      delivered({ confirmedAt: "2026-05-01T00:00:00Z", deliveredAt: "2026-05-02T00:00:00Z" }),
      delivered({ confirmedAt: "2026-05-03T00:00:00Z", deliveredAt: "2026-05-05T00:00:00Z" }),
      delivered({ confirmedAt: "2026-05-10T00:00:00Z", deliveredAt: "2026-05-13T00:00:00Z" }),
    ]);
    const result = await shipmentTransitTimeReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.carrier).toBe(ShipmentCarrier.FEDEX);
    expect(row.serviceLevel).toBe("FEDEX_GROUND");
    expect(row.shipmentCount).toBe(3);
    expect(row.avgTransitHours).toBe(48);
    expect(row.p50TransitHours).toBe(48);
    expect(row.p95TransitHours).toBe(72);
  });

  it("splits on-time / late / no-estimate against the carrier estimate", async () => {
    const client = fakeClient([
      // Delivered before the estimate → on time.
      delivered({
        confirmedAt: "2026-05-01T00:00:00Z",
        deliveredAt: "2026-05-02T00:00:00Z",
        estimatedAt: "2026-05-03T00:00:00Z",
      }),
      // Delivered after the estimate → late.
      delivered({
        confirmedAt: "2026-05-01T00:00:00Z",
        deliveredAt: "2026-05-05T00:00:00Z",
        estimatedAt: "2026-05-03T00:00:00Z",
      }),
      // No estimate recorded → counted separately, not diluting the rate.
      delivered({ confirmedAt: "2026-05-01T00:00:00Z", deliveredAt: "2026-05-02T00:00:00Z" }),
    ]);
    const result = await shipmentTransitTimeReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    const row = result.rows[0]!;
    expect(row.onTimeCount).toBe(1);
    expect(row.lateCount).toBe(1);
    expect(row.noEstimateCount).toBe(1);
    // Rate over shipments WITH an estimate: 1 of 2 = 5000 bps.
    expect(result.aggregates["onTimeRateBps"]).toBe(5000);
    expect(result.aggregates["totalCount"]).toBe(3);
  });

  it("prefers the persisted pickup→delivery pair over the handoff fallback", async () => {
    const client = fakeClient([
      // Handoff→delivered-scan says 48h, but the persisted scan
      // endpoints say pickup happened 24h after our handoff stamp —
      // true carrier transit is 24h and that is what must be
      // reported.
      delivered({
        confirmedAt: "2026-05-01T00:00:00Z",
        deliveredAt: "2026-05-03T00:00:00Z",
        transit: {
          pickedUpAt: "2026-05-02T00:00:00Z",
          deliveredAt: "2026-05-03T00:00:00Z",
        },
      }),
    ]);
    const result = await shipmentTransitTimeReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows[0]!.avgTransitHours).toBe(24);
  });

  it("drops negative-transit rows (clock skew) instead of reporting them", async () => {
    const client = fakeClient([
      delivered({ confirmedAt: "2026-05-05T00:00:00Z", deliveredAt: "2026-05-04T00:00:00Z" }),
    ]);
    const result = await shipmentTransitTimeReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    expect(result.rows).toHaveLength(0);
    expect(result.aggregates["totalCount"]).toBe(0);
  });
});

describe("shipmentTransitTimeReport — query shape", () => {
  it("scopes by org, DELIVERED status, delivered-in-window, and confirmed handoff", async () => {
    const client = fakeClient([]);
    await shipmentTransitTimeReport.run(
      { client: client as never, organizationId: ORG_ID },
      { ...window, carriers: [ShipmentCarrier.FEDEX] }
    );
    const call = client.shipment.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(call.where["organizationId"]).toBe(ORG_ID);
    expect(call.where["status"]).toBe(ShipmentStatus.DELIVERED);
    expect(call.where["confirmedAt"]).toEqual({ not: null });
    expect(call.where["lastTrackingEventAt"]).toEqual({ gte: window.from, lte: window.to });
    expect(call.where["carrier"]).toEqual({ in: [ShipmentCarrier.FEDEX] });
  });

  it("narrows to the context clinic via the order relation", async () => {
    const CLINIC = "00000000-0000-4000-8000-000000000010";
    const client = fakeClient([]);
    await shipmentTransitTimeReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC },
      window
    );
    const call = client.shipment.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(call.where["order"]).toEqual({ clinicId: CLINIC });
  });
});

describe("shipmentTransitTimeReport — parameter schema", () => {
  it("rejects from > to", () => {
    const parsed = shipmentTransitTimeReport.parametersSchema.safeParse({
      from: new Date("2026-06-01"),
      to: new Date("2026-05-01"),
    });
    expect(parsed.success).toBe(false);
  });
});
