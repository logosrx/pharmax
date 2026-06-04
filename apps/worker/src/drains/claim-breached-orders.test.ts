import { describe, expect, it, vi } from "vitest";

import { claimBreachedOrders, type BreachedOrderClaimClient } from "./claim-breached-orders.js";

function makeClient(rows: ReadonlyArray<Record<string, unknown>>): BreachedOrderClaimClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue(rows),
  } as unknown as BreachedOrderClaimClient;
}

describe("claimBreachedOrders", () => {
  it("returns an empty array when no orders are breached", async () => {
    const client = makeClient([]);
    const out = await claimBreachedOrders(client, { batchSize: 50 });
    expect(out).toEqual([]);
  });

  it("projects + freezes returned rows", async () => {
    const slaDeadlineAt = new Date("2026-05-25T12:00:00.000Z");
    const client = makeClient([
      {
        id: "ord-1",
        organizationId: "org-1",
        currentStatus: "FILL_IN_PROGRESS",
        slaDeadlineAt,
      },
    ]);

    const out = await claimBreachedOrders(client, { batchSize: 50 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "ord-1",
      organizationId: "org-1",
      currentStatus: "FILL_IN_PROGRESS",
      slaDeadlineAt,
    });
    expect(Object.isFrozen(out[0])).toBe(true);
  });

  it("passes the batch size into the query", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const client = { $queryRaw: queryRaw } as unknown as BreachedOrderClaimClient;
    await claimBreachedOrders(client, { batchSize: 7 });
    // Tagged-template call: values are the trailing args.
    const values = queryRaw.mock.calls[0]!.slice(1);
    expect(values).toContain(7);
  });
});
