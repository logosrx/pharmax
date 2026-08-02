import { ShipmentCarrier, ShipmentStatus } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lateDeliveriesReport } from "./late-deliveries.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-31T12:00:00.000Z");

interface FakeShipment {
  carrier: ShipmentCarrier;
  serviceLevel: string;
  trackingNumber: string;
  status: ShipmentStatus;
  estimatedDeliveryAt: Date | null;
  lastTrackingEventAt: Date | null;
  postageRateCents: number | null;
}

function fakeClient(input: {
  delivered: ReadonlyArray<FakeShipment>;
  outstanding: ReadonlyArray<FakeShipment>;
}) {
  // First findMany call = delivered-late query, second = outstanding.
  const findMany = vi
    .fn(async (_args: unknown) => [] as ReadonlyArray<FakeShipment>)
    .mockResolvedValueOnce(input.delivered)
    .mockResolvedValueOnce(input.outstanding);
  return { shipment: { findMany } };
}

const window = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-31T23:59:59.999Z"),
};

function shipment(overrides: Partial<FakeShipment>): FakeShipment {
  return {
    carrier: ShipmentCarrier.FEDEX,
    serviceLevel: "FEDEX_GROUND",
    trackingNumber: "794665654567",
    status: ShipmentStatus.DELIVERED,
    estimatedDeliveryAt: null,
    lastTrackingEventAt: null,
    postageRateCents: 1250,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lateDeliveriesReport — miss categorization", () => {
  it("classifies delivered-late and still-outstanding rows with hoursLate", async () => {
    const client = fakeClient({
      delivered: [
        // Delivered 12h after estimate → DELIVERED_LATE.
        shipment({
          trackingNumber: "794665654568",
          estimatedDeliveryAt: new Date("2026-07-10T00:00:00.000Z"),
          lastTrackingEventAt: new Date("2026-07-10T12:00:00.000Z"),
        }),
        // Delivered ON TIME → excluded even though the query returned it.
        shipment({
          trackingNumber: "794665654569",
          estimatedDeliveryAt: new Date("2026-07-10T00:00:00.000Z"),
          lastTrackingEventAt: new Date("2026-07-09T20:00:00.000Z"),
        }),
      ],
      outstanding: [
        // Estimate passed 48h ago and still IN_TRANSIT.
        shipment({
          trackingNumber: "794665654570",
          status: ShipmentStatus.IN_TRANSIT,
          estimatedDeliveryAt: new Date("2026-07-29T12:00:00.000Z"),
          postageRateCents: null,
        }),
      ],
    });

    const result = await lateDeliveriesReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: NOW },
      { ...window, minHoursLate: 0 }
    );

    expect(result.rows).toHaveLength(2);
    const byTracking = new Map(result.rows.map((r) => [r.trackingNumber, r]));

    const deliveredLate = byTracking.get("794665654568")!;
    expect(deliveredLate.outcome).toBe("DELIVERED_LATE");
    expect(deliveredLate.hoursLate).toBe(12);
    expect(deliveredLate.postageRateCents).toBe(1250);

    const outstanding = byTracking.get("794665654570")!;
    expect(outstanding.outcome).toBe("STILL_OUTSTANDING");
    expect(outstanding.hoursLate).toBe(48);
    expect(outstanding.deliveredAt).toBeNull();
    expect(outstanding.postageRateCents).toBeNull();

    // Worst offender first.
    expect(result.rows[0]!.trackingNumber).toBe("794665654570");

    expect(result.aggregates).toEqual({
      totalCount: 2,
      deliveredLateCount: 1,
      stillOutstandingCount: 1,
      avgHoursLateTenths: 300, // (12 + 48) / 2 = 30.0h
    });
  });

  it("applies the minHoursLate grace window to both categories", async () => {
    const client = fakeClient({
      delivered: [
        // Only 2h late — inside a 4h grace window.
        shipment({
          estimatedDeliveryAt: new Date("2026-07-10T00:00:00.000Z"),
          lastTrackingEventAt: new Date("2026-07-10T02:00:00.000Z"),
        }),
      ],
      outstanding: [
        // 3h past estimate — also inside grace.
        shipment({
          status: ShipmentStatus.IN_TRANSIT,
          estimatedDeliveryAt: new Date("2026-07-31T09:00:00.000Z"),
        }),
      ],
    });

    const result = await lateDeliveriesReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: NOW },
      { ...window, minHoursLate: 4 }
    );

    expect(result.rows).toHaveLength(0);
    expect(result.aggregates["totalCount"]).toBe(0);
  });
});

describe("lateDeliveriesReport — query shape", () => {
  it("scopes both queries by org and clinic via the order relation", async () => {
    const CLINIC = "00000000-0000-4000-8000-000000000010";
    const client = fakeClient({ delivered: [], outstanding: [] });
    await lateDeliveriesReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC, asOf: NOW },
      { ...window, minHoursLate: 0 }
    );

    expect(client.shipment.findMany).toHaveBeenCalledTimes(2);
    for (const call of client.shipment.findMany.mock.calls) {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      expect(where["organizationId"]).toBe(ORG_ID);
      expect(where["order"]).toEqual({ clinicId: CLINIC });
    }
    // Delivered query pins DELIVERED + estimate present; outstanding
    // excludes DELIVERED + estimate already passed.
    const deliveredWhere = (
      client.shipment.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      }
    ).where;
    expect(deliveredWhere["status"]).toBe(ShipmentStatus.DELIVERED);
    expect(deliveredWhere["estimatedDeliveryAt"]).toEqual({ not: null });
    const outstandingWhere = (
      client.shipment.findMany.mock.calls[1]![0] as {
        where: Record<string, unknown>;
      }
    ).where;
    expect(outstandingWhere["status"]).toEqual({ not: ShipmentStatus.DELIVERED });
    expect(outstandingWhere["estimatedDeliveryAt"]).toEqual({ lt: NOW });
  });
});

describe("lateDeliveriesReport — parameter schema", () => {
  it("defaults minHoursLate to 0 and rejects from > to", () => {
    const ok = lateDeliveriesReport.parametersSchema.safeParse({
      from: new Date("2026-07-01"),
      to: new Date("2026-07-31"),
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.minHoursLate).toBe(0);

    const bad = lateDeliveriesReport.parametersSchema.safeParse({
      from: new Date("2026-08-01"),
      to: new Date("2026-07-01"),
    });
    expect(bad.success).toBe(false);
  });
});
