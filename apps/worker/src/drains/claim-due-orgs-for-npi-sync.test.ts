import { describe, expect, it, vi } from "vitest";

import { claimDueOrgsForNpiSync, type NpiSyncClaimClient } from "./claim-due-orgs-for-npi-sync.js";

function makeClient(rows: ReadonlyArray<Record<string, unknown>>): {
  client: NpiSyncClaimClient;
  queryRaw: ReturnType<typeof vi.fn>;
} {
  const queryRaw = vi.fn().mockResolvedValue(rows);
  const client = { $queryRaw: queryRaw } as unknown as NpiSyncClaimClient;
  return { client, queryRaw };
}

describe("claimDueOrgsForNpiSync", () => {
  it("returns an empty array when no orgs are due", async () => {
    const { client } = makeClient([]);
    const out = await claimDueOrgsForNpiSync(client, {
      batchSize: 25,
      cadenceMs: 86_400_000,
    });
    expect(out).toEqual([]);
  });

  it("projects + freezes returned rows; threads cadence/batch into the query", async () => {
    const lastSuccess = new Date("2026-05-27T09:00:00.000Z");
    const { client, queryRaw } = makeClient([
      {
        organizationId: "00000000-0000-4000-8000-000000000001",
        organizationSlug: "acme",
        lastSuccessfulRunAt: lastSuccess,
      },
      {
        organizationId: "00000000-0000-4000-8000-000000000002",
        organizationSlug: "globex",
        lastSuccessfulRunAt: null, // never synced
      },
    ]);

    const out = await claimDueOrgsForNpiSync(client, {
      batchSize: 25,
      cadenceMs: 86_400_000,
    });

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      organizationId: "00000000-0000-4000-8000-000000000001",
      organizationSlug: "acme",
      lastSuccessfulRunAt: lastSuccess,
    });
    expect(Object.isFrozen(out[0])).toBe(true);
    expect(out[1]).toMatchObject({
      organizationId: "00000000-0000-4000-8000-000000000002",
      organizationSlug: "globex",
      lastSuccessfulRunAt: null,
    });
    expect(Object.isFrozen(out[1])).toBe(true);
    // The tagged template literal threads cadenceMs + batchSize as
    // expression values; ensure both were passed (positional args
    // 1, 2 in the values array because the SQL template references
    // them in order: cadenceMs, then batchSize).
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const firstCall = queryRaw.mock.calls[0]!;
    // tagged-template signature: [strings, ...values]
    const values = firstCall.slice(1);
    expect(values).toContain(86_400_000);
    expect(values).toContain(25);
  });

  it("propagates database errors (caller decides how to surface them)", async () => {
    const queryRaw = vi.fn().mockRejectedValue(new Error("pg connection lost"));
    const client = { $queryRaw: queryRaw } as unknown as NpiSyncClaimClient;
    await expect(
      claimDueOrgsForNpiSync(client, { batchSize: 25, cadenceMs: 86_400_000 })
    ).rejects.toThrow(/pg connection lost/);
  });
});
