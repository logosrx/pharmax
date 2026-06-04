import { describe, expect, it, vi } from "vitest";

import { cached, cacheKey } from "./cached.js";
import { InMemoryCache } from "./in-memory-cache.js";
import { NoopCache } from "./noop-cache.js";
import type { Cache } from "./cache.js";

describe("cached — read-through", () => {
  it("loads on a miss, writes back, and serves the cached value next time", async () => {
    const cache = new InMemoryCache();
    const load = vi.fn(async () => ({ v: 42 }));

    const first = await cached({ cache, key: "k", ttlMs: 1000, load });
    const second = await cached({ cache, key: "k", ttlMs: 1000, load });

    expect(first).toEqual({ v: 42 });
    expect(second).toEqual({ v: 42 });
    expect(load).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it("with NoopCache always calls the loader (feature-flag-off parity)", async () => {
    const cache = new NoopCache();
    const load = vi.fn(async () => "v");
    await cached({ cache, key: "k", ttlMs: 1000, load });
    await cached({ cache, key: "k", ttlMs: 1000, load });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never negatively caches a null result", async () => {
    const cache = new InMemoryCache();
    const load = vi.fn(async () => null);
    await cached({ cache, key: "k", ttlMs: 1000, load });
    await cached({ cache, key: "k", ttlMs: 1000, load });
    expect(load).toHaveBeenCalledTimes(2); // null was not cached
  });
});

describe("cached — safe degradation", () => {
  it("falls through to the loader when get throws (and reports it)", async () => {
    const onError = vi.fn();
    const throwingGet: Cache = {
      get: vi.fn(async () => {
        throw new Error("redis down");
      }),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      deletePrefix: vi.fn(async () => undefined),
    };
    const load = vi.fn(async () => "from-db");

    const result = await cached({ cache: throwingGet, key: "k", ttlMs: 1000, load, onError });

    expect(result).toBe("from-db");
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("get", expect.any(Error));
  });

  it("still returns the loaded value when set throws", async () => {
    const onError = vi.fn();
    const throwingSet: Cache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error("redis down");
      }),
      delete: vi.fn(async () => undefined),
      deletePrefix: vi.fn(async () => undefined),
    };
    const load = vi.fn(async () => "from-db");

    const result = await cached({ cache: throwingSet, key: "k", ttlMs: 1000, load, onError });

    expect(result).toBe("from-db");
    expect(onError).toHaveBeenCalledWith("set", expect.any(Error));
  });
});

describe("cacheKey", () => {
  it("builds namespaced, versioned keys", () => {
    expect(cacheKey("identity", 1, "user_2ab")).toBe("identity:v1:user_2ab");
    expect(cacheKey("perms", 1, "orgA", "u1")).toBe("perms:v1:orgA:u1");
  });

  it("supports a bare namespace:version prefix for deletePrefix", () => {
    // The org-wide invalidation prefix is `${cacheKey("perms", 1, orgId)}:`.
    expect(`${cacheKey("perms", 1, "orgA")}:`).toBe("perms:v1:orgA:");
  });
});
