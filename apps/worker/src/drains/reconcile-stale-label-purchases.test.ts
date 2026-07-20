// Stale label-purchase reconciler — disposition state machine.

import { describe, expect, it, vi } from "vitest";

import { clock as clockNs, logger as loggerNs } from "@pharmax/platform-core";

import {
  createStaleLabelPurchaseReconciler,
  PURCHASE_LABEL_RECONCILIATION_REQUIRED,
} from "./reconcile-stale-label-purchases.js";

const NOW = new Date("2026-07-20T16:00:00.000Z");
const STALE_STARTED_AT = new Date("2026-07-20T15:30:00.000Z"); // 30 min old
const ORG = "00000000-0000-4000-8000-000000000001";
const ORDER = "00000000-0000-4000-8000-000000000002";
const SHIPMENT = "00000000-0000-4000-8000-000000000003";

interface FakeCommandLogRow {
  id: string;
  organizationId: string;
  requestPayload: unknown;
  startedAt: Date;
}

function buildClient(input: {
  staleRows: FakeCommandLogRow[];
  shipmentExists: boolean;
  updateManyCount?: number;
}) {
  const updateMany = vi.fn(async () => ({ count: input.updateManyCount ?? 1 }));
  return {
    client: {
      commandLog: {
        findMany: vi.fn(async () => input.staleRows),
        updateMany,
      },
      shipment: {
        findFirst: vi.fn(async () => (input.shipmentExists ? { id: SHIPMENT } : null)),
      },
    },
    updateMany,
  };
}

function buildReconciler(client: unknown) {
  return createStaleLabelPurchaseReconciler(
    {
      client: client as never,
      logger: loggerNs.noopLogger,
      clock: clockNs.createFrozenClock(NOW),
    },
    { batchSize: 50, staleAfterMs: 15 * 60_000 }
  );
}

const staleRow: FakeCommandLogRow = {
  id: "cl-stale-1",
  organizationId: ORG,
  requestPayload: { orderId: ORDER, provider: "EASYPOST" },
  startedAt: STALE_STARTED_AT,
};

describe("createStaleLabelPurchaseReconciler.tick", () => {
  it("returns zeros when nothing is stale", async () => {
    const { client } = buildClient({ staleRows: [], shipmentExists: false });
    const result = await buildReconciler(client).tick();
    expect(result).toEqual({ scanned: 0, committed: 0, needsCarrierCheck: 0, lostRace: 0 });
  });

  it("marks SUCCEEDED (fenced on RUNNING) when the shipment row committed", async () => {
    const { client, updateMany } = buildClient({ staleRows: [staleRow], shipmentExists: true });
    const result = await buildReconciler(client).tick();

    expect(result).toEqual({ scanned: 1, committed: 1, needsCarrierCheck: 0, lostRace: 0 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "cl-stale-1", status: "RUNNING" },
      data: { status: "SUCCEEDED", completedAt: NOW },
    });
  });

  it("marks FAILED + RECONCILIATION_REQUIRED when no shipment committed (possible orphaned charge)", async () => {
    const { client, updateMany } = buildClient({ staleRows: [staleRow], shipmentExists: false });
    const result = await buildReconciler(client).tick();

    expect(result).toEqual({ scanned: 1, committed: 0, needsCarrierCheck: 1, lostRace: 0 });
    const call = (
      updateMany.mock.calls as unknown as ReadonlyArray<
        readonly [{ where: Record<string, unknown>; data: Record<string, unknown> }]
      >
    )[0]![0];
    expect(call.where).toEqual({ id: "cl-stale-1", status: "RUNNING" });
    expect(call.data["status"]).toBe("FAILED");
    expect(call.data["errorCode"]).toBe(PURCHASE_LABEL_RECONCILIATION_REQUIRED);
    expect(String(call.data["errorMessage"])).toContain("carrier dashboard");
    // The breadcrumb includes WHEN the purchase started so billing
    // can find the orphaned label in the carrier's history.
    expect(String(call.data["errorMessage"])).toContain(STALE_STARTED_AT.toISOString());
  });

  it("counts lostRace (no overwrite) when the row completed between read and write", async () => {
    const { client } = buildClient({
      staleRows: [staleRow],
      shipmentExists: true,
      updateManyCount: 0,
    });
    const result = await buildReconciler(client).tick();
    expect(result).toEqual({ scanned: 1, committed: 0, needsCarrierCheck: 0, lostRace: 1 });
  });

  it("queries only stale RUNNING PurchaseShipmentLabel rows", async () => {
    const { client } = buildClient({ staleRows: [], shipmentExists: false });
    await buildReconciler(client).tick();
    const where = (
      client.commandLog.findMany.mock.calls as unknown as ReadonlyArray<
        readonly [{ where: Record<string, unknown> }]
      >
    )[0]![0].where;
    expect(where["commandName"]).toBe("PurchaseShipmentLabel");
    expect(where["status"]).toBe("RUNNING");
    expect(where["startedAt"]).toEqual({ lte: new Date(NOW.getTime() - 15 * 60_000) });
  });
});
