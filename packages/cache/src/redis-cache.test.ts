import { describe, expect, it, vi } from "vitest";

import { RedisCache, type RedisLikeClient } from "./redis-cache.js";

function fakeClient(overrides: Partial<RedisLikeClient> = {}): RedisLikeClient {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    scanPrefix: vi.fn(async () => []),
    ...overrides,
  };
}

describe("RedisCache", () => {
  it("serializes on set with a millisecond TTL", async () => {
    const client = fakeClient();
    const cache = new RedisCache(client);
    await cache.set("k", { a: 1 }, { ttlMs: 1500 });
    expect(client.set).toHaveBeenCalledWith("k", JSON.stringify({ a: 1 }), 1500);
  });

  it("parses JSON on get", async () => {
    const client = fakeClient({ get: vi.fn(async () => JSON.stringify(["x", "y"])) });
    const cache = new RedisCache(client);
    expect(await cache.get<string[]>("k")).toEqual(["x", "y"]);
  });

  it("returns null when the client has no value", async () => {
    const cache = new RedisCache(fakeClient({ get: vi.fn(async () => null) }));
    expect(await cache.get("k")).toBeNull();
  });

  it("deletes a single key", async () => {
    const client = fakeClient();
    await new RedisCache(client).delete("k");
    expect(client.del).toHaveBeenCalledWith("k");
  });

  it("deletePrefix scans then deletes each matched key", async () => {
    const client = fakeClient({
      scanPrefix: vi.fn(async () => ["perms:v1:orgA:u1", "perms:v1:orgA:u2"]),
    });
    await new RedisCache(client).deletePrefix("perms:v1:orgA:");
    expect(client.scanPrefix).toHaveBeenCalledWith("perms:v1:orgA:");
    expect(client.del).toHaveBeenCalledTimes(2);
    expect(client.del).toHaveBeenCalledWith("perms:v1:orgA:u1");
    expect(client.del).toHaveBeenCalledWith("perms:v1:orgA:u2");
  });
});
