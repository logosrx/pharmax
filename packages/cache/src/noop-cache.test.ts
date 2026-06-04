import { describe, expect, it } from "vitest";

import { NoopCache } from "./noop-cache.js";

describe("NoopCache", () => {
  it("always misses, even after a set", async () => {
    const cache = new NoopCache();
    await cache.set("k", "v", { ttlMs: 1000 });
    expect(await cache.get("k")).toBeNull();
  });

  it("delete and deletePrefix are no-ops that resolve", async () => {
    const cache = new NoopCache();
    await expect(cache.delete("k")).resolves.toBeUndefined();
    await expect(cache.deletePrefix("p")).resolves.toBeUndefined();
  });
});
