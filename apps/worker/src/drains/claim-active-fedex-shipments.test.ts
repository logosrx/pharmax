import { describe, expect, it, vi } from "vitest";

import {
  claimActiveFedExShipments,
  type FedExShipmentClaimClient,
} from "./claim-active-fedex-shipments.js";

function makeClient(rows: ReadonlyArray<Record<string, unknown>>): FedExShipmentClaimClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue(rows),
  } as unknown as FedExShipmentClaimClient;
}

describe("claimActiveFedExShipments", () => {
  it("returns an empty array when no shipments are due", async () => {
    const client = makeClient([]);
    const result = await claimActiveFedExShipments(client, {
      batchSize: 50,
      staleThresholdMs: 60_000,
    });
    expect(result).toEqual([]);
  });

  it("freezes returned rows and projects the expected columns", async () => {
    const lastTrackingEventAt = new Date("2026-05-25T08:00:00.000Z");
    const client = makeClient([
      {
        id: "shp-1",
        organizationId: "org-1",
        siteId: "site-1",
        trackingNumber: "794665654567",
        lastTrackingEventAt,
      },
      {
        id: "shp-2",
        organizationId: "org-1",
        siteId: "site-1",
        trackingNumber: "794665654568",
        lastTrackingEventAt: null,
      },
    ]);

    const result = await claimActiveFedExShipments(client, {
      batchSize: 50,
      staleThresholdMs: 60_000,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "shp-1",
      organizationId: "org-1",
      siteId: "site-1",
      trackingNumber: "794665654567",
      lastTrackingEventAt,
    });
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(result[1]!.lastTrackingEventAt).toBeNull();
  });

  it("passes batchSize + staleThresholdMs to the query as bound parameters", async () => {
    const client = makeClient([]);
    await claimActiveFedExShipments(client, { batchSize: 25, staleThresholdMs: 7_200_000 });
    // $queryRaw is a tagged-template function; vitest's fn captures
    // the tuple (template, ...values). We check the values payload.
    const calls = (client.$queryRaw as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [, ...values] = calls[0]!;
    expect(values).toContain(7_200_000);
    expect(values).toContain(25);
  });
});
