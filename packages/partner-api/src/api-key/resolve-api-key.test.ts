import { describe, expect, it } from "vitest";

import {
  RESOLVE_API_KEY_MALFORMED,
  RESOLVE_API_KEY_NOT_FOUND,
  RESOLVE_API_KEY_REVOKED,
  resolveApiKey,
  type ResolveApiKeyClient,
} from "./resolve-api-key.js";
import { generateApiKeyToken } from "./token.js";

interface FakeKeyRow {
  id: string;
  organizationId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes: string[];
  status: "ACTIVE" | "REVOKED";
  lastUsedAt: Date | null;
  createdByUserId: string;
}

/**
 * Minimal fake of the `$transaction(fn)` surface `resolveApiKey`
 * touches: system GUC + apiKey.findUnique/update.
 */
function createFakeClient(rows: FakeKeyRow[]): {
  client: ResolveApiKeyClient;
  updates: Array<{ id: string; lastUsedAt: Date }>;
} {
  const updates: Array<{ id: string; lastUsedAt: Date }> = [];
  const tx = {
    $executeRaw: async () => 0,
    apiKey: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        rows.find((r) => r.tokenHash === where.tokenHash) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { lastUsedAt: Date } }) => {
        updates.push({ id: where.id, lastUsedAt: data.lastUsedAt });
        return { id: where.id };
      },
    },
  };
  const client = {
    $transaction: (async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) as never,
  } as unknown as ResolveApiKeyClient;
  return { client, updates };
}

function makeRow(overrides: Partial<FakeKeyRow> & { tokenHash: string }): FakeKeyRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    name: "Test key",
    tokenPrefix: "pxk_abcd",
    scopes: ["orders.read"],
    status: "ACTIVE",
    lastUsedAt: null,
    createdByUserId: "33333333-3333-4333-8333-333333333333",
    ...overrides,
  };
}

describe("resolveApiKey", () => {
  it("rejects malformed tokens without touching the client", async () => {
    let touched = false;
    const client = {
      $transaction: (async () => {
        touched = true;
        return null;
      }) as never,
    } as unknown as ResolveApiKeyClient;

    const result = await resolveApiKey({ rawToken: "not-a-token", client });
    expect(result).toEqual({ ok: false, reason: RESOLVE_API_KEY_MALFORMED });
    expect(touched).toBe(false);
  });

  it("returns NOT_FOUND for an unknown (well-formed) token", async () => {
    const { client } = createFakeClient([]);
    const result = await resolveApiKey({ rawToken: generateApiKeyToken().token, client });
    expect(result).toEqual({ ok: false, reason: RESOLVE_API_KEY_NOT_FOUND });
  });

  it("returns REVOKED for a revoked key and does NOT bump lastUsedAt", async () => {
    const generated = generateApiKeyToken();
    const { client, updates } = createFakeClient([
      makeRow({ tokenHash: generated.tokenHash, status: "REVOKED" }),
    ]);
    const result = await resolveApiKey({ rawToken: generated.token, client });
    expect(result).toEqual({ ok: false, reason: RESOLVE_API_KEY_REVOKED });
    expect(updates).toHaveLength(0);
  });

  it("resolves an active key with its org, scopes, and minter", async () => {
    const generated = generateApiKeyToken();
    const row = makeRow({
      tokenHash: generated.tokenHash,
      scopes: ["orders.read", "webhooks.manage"],
    });
    const { client } = createFakeClient([row]);

    const result = await resolveApiKey({ rawToken: generated.token, client });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.key.apiKeyId).toBe(row.id);
      expect(result.key.organizationId).toBe(row.organizationId);
      expect(result.key.scopes).toEqual(["orders.read", "webhooks.manage"]);
      expect(result.key.createdByUserId).toBe(row.createdByUserId);
    }
  });

  it("bumps lastUsedAt on first use, then throttles within the window", async () => {
    const generated = generateApiKeyToken();
    const t0 = new Date("2026-07-24T12:00:00.000Z");
    const row = makeRow({ tokenHash: generated.tokenHash, lastUsedAt: null });
    const { client, updates } = createFakeClient([row]);

    await resolveApiKey({ rawToken: generated.token, client, clock: () => t0 });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.lastUsedAt).toEqual(t0);

    // 30s later — inside the 60s throttle — no second write.
    row.lastUsedAt = t0;
    await resolveApiKey({
      rawToken: generated.token,
      client,
      clock: () => new Date(t0.getTime() + 30_000),
    });
    expect(updates).toHaveLength(1);

    // 61s later — past the throttle — writes again.
    await resolveApiKey({
      rawToken: generated.token,
      client,
      clock: () => new Date(t0.getTime() + 61_000),
    });
    expect(updates).toHaveLength(2);
  });
});
