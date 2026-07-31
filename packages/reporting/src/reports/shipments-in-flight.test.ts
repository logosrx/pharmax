import { ShipmentCarrier, ShipmentStatus, ShipmentTrackingEventKind } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shipmentsInFlightReport } from "./shipments-in-flight.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-05-31T12:00:00.000Z");

interface FakeLatestEvent {
  kind: ShipmentTrackingEventKind;
  occurredAt: Date;
  scanCity: string | null;
  scanStateOrProvince: string | null;
}

interface FakeShipment {
  carrier: ShipmentCarrier;
  serviceLevel: string;
  trackingNumber: string;
  status: ShipmentStatus;
  estimatedDeliveryAt: Date | null;
  lastTrackingEventAt: Date | null;
  trackingEvents: FakeLatestEvent[];
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

function inFlight(input: Partial<FakeShipment>): FakeShipment {
  return {
    carrier: ShipmentCarrier.FEDEX,
    serviceLevel: "FEDEX_GROUND",
    trackingNumber: "794665654567",
    status: ShipmentStatus.IN_TRANSIT,
    estimatedDeliveryAt: null,
    lastTrackingEventAt: null,
    trackingEvents: [],
    ...input,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shipmentsInFlightReport — rows", () => {
  it("surfaces last scan location + freshness from the newest carrier event", async () => {
    const lastScan = new Date("2026-05-31T06:00:00.000Z"); // 6h before NOW
    const client = fakeClient([
      inFlight({
        lastTrackingEventAt: lastScan,
        trackingEvents: [
          {
            kind: ShipmentTrackingEventKind.IN_TRANSIT,
            occurredAt: lastScan,
            scanCity: "MEMPHIS",
            scanStateOrProvince: "TN",
          },
        ],
      }),
    ]);
    const result = await shipmentsInFlightReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: NOW },
      { ...window, staleThresholdHours: 24 }
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.lastScanCity).toBe("MEMPHIS");
    expect(row.lastScanState).toBe("TN");
    expect(row.lastEventKind).toBe(ShipmentTrackingEventKind.IN_TRANSIT);
    expect(row.hoursSinceLastEvent).toBe(6);
    expect(row.stale).toBe(false);
  });

  it("flags stale, never-scanned, and past-estimate shipments", async () => {
    const client = fakeClient([
      // Dark for 48h with a 24h threshold → stale.
      inFlight({
        trackingNumber: "794665654568",
        lastTrackingEventAt: new Date("2026-05-29T12:00:00.000Z"),
        trackingEvents: [
          {
            kind: ShipmentTrackingEventKind.IN_TRANSIT,
            occurredAt: new Date("2026-05-29T12:00:00.000Z"),
            scanCity: null,
            scanStateOrProvince: null,
          },
        ],
      }),
      // Never scanned → stale + neverScanned, hoursSinceLastEvent -1.
      inFlight({ trackingNumber: "794665654569" }),
      // Past the carrier estimate and still moving.
      inFlight({
        trackingNumber: "794665654570",
        estimatedDeliveryAt: new Date("2026-05-30T00:00:00.000Z"),
        lastTrackingEventAt: new Date("2026-05-31T11:00:00.000Z"),
        trackingEvents: [
          {
            kind: ShipmentTrackingEventKind.EXCEPTION,
            occurredAt: new Date("2026-05-31T11:00:00.000Z"),
            scanCity: "NASHVILLE",
            scanStateOrProvince: "TN",
          },
        ],
        status: ShipmentStatus.EXCEPTION,
      }),
    ]);
    const result = await shipmentsInFlightReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: NOW },
      { ...window, staleThresholdHours: 24 }
    );

    const byTracking = new Map(result.rows.map((r) => [r.trackingNumber, r]));
    expect(byTracking.get("794665654568")!.stale).toBe(true);
    expect(byTracking.get("794665654569")!.hoursSinceLastEvent).toBe(-1);
    expect(byTracking.get("794665654569")!.stale).toBe(true);
    expect(byTracking.get("794665654570")!.pastEstimate).toBe(true);
    expect(byTracking.get("794665654570")!.stale).toBe(false);

    expect(result.aggregates).toEqual({
      totalInFlight: 3,
      staleCount: 2,
      pastEstimateCount: 1,
      exceptionCount: 1,
      neverScannedCount: 1,
    });
  });
});

describe("shipmentsInFlightReport — query shape", () => {
  it("excludes DELIVERED, scopes by org + window, sorts stalest-first with nulls first", async () => {
    const client = fakeClient([]);
    await shipmentsInFlightReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: NOW },
      { ...window, staleThresholdHours: 24 }
    );
    const call = client.shipment.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
      take: number;
    };
    expect(call.where["organizationId"]).toBe(ORG_ID);
    expect(call.where["status"]).toEqual({ not: ShipmentStatus.DELIVERED });
    expect(call.where["createdAt"]).toEqual({ gte: window.from, lte: window.to });
    expect(call.orderBy).toEqual([{ lastTrackingEventAt: { sort: "asc", nulls: "first" } }]);
    expect(call.take).toBeGreaterThan(0);
  });

  it("narrows to the context clinic via the order relation", async () => {
    const CLINIC = "00000000-0000-4000-8000-000000000010";
    const client = fakeClient([]);
    await shipmentsInFlightReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC, asOf: NOW },
      { ...window, staleThresholdHours: 24 }
    );
    const call = client.shipment.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(call.where["order"]).toEqual({ clinicId: CLINIC });
  });
});

describe("shipmentsInFlightReport — parameter schema", () => {
  it("defaults staleThresholdHours to 24", () => {
    const parsed = shipmentsInFlightReport.parametersSchema.safeParse({
      from: new Date("2026-05-01"),
      to: new Date("2026-05-31"),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.staleThresholdHours).toBe(24);
    }
  });

  it("rejects from > to", () => {
    const parsed = shipmentsInFlightReport.parametersSchema.safeParse({
      from: new Date("2026-06-01"),
      to: new Date("2026-05-01"),
    });
    expect(parsed.success).toBe(false);
  });
});
