import { describe, expect, it } from "vitest";

import { InMemoryCache } from "./in-memory-cache.js";

describe("InMemoryCache", () => {
  it("round-trips a value within its TTL", async () => {
    const cache = new InMemoryCache();
    await cache.set("k", { a: 1, b: "two" }, { ttlMs: 1000 });
    expect(await cache.get<{ a: number; b: string }>("k")).toEqual({ a: 1, b: "two" });
  });

  it("returns null for an absent key", async () => {
    const cache = new InMemoryCache();
    expect(await cache.get("missing")).toBeNull();
  });

  it("expires entries after ttlMs (inclusive at the boundary)", async () => {
    let nowMs = 1_000;
    const cache = new InMemoryCache({ now: () => nowMs });
    await cache.set("k", "v", { ttlMs: 50 });
    nowMs = 1_049;
    expect(await cache.get("k")).toBe("v");
    nowMs = 1_050; // expiresAt = 1050; <= now → expired
    expect(await cache.get("k")).toBeNull();
  });

  it("isolates the cached value from later mutation of the source object", async () => {
    const cache = new InMemoryCache();
    const source = { tags: ["a"] };
    await cache.set("k", source, { ttlMs: 1000 });
    source.tags.push("b");
    expect(await cache.get<{ tags: string[] }>("k")).toEqual({ tags: ["a"] });
  });

  it("deletes a single key", async () => {
    const cache = new InMemoryCache();
    await cache.set("k", 1, { ttlMs: 1000 });
    await cache.delete("k");
    expect(await cache.get("k")).toBeNull();
  });

  it("deletes by prefix without touching other namespaces", async () => {
    const cache = new InMemoryCache();
    await cache.set("perms:v1:orgA:u1", 1, { ttlMs: 1000 });
    await cache.set("perms:v1:orgA:u2", 2, { ttlMs: 1000 });
    await cache.set("perms:v1:orgB:u9", 9, { ttlMs: 1000 });
    await cache.set("identity:v1:u1", 7, { ttlMs: 1000 });

    await cache.deletePrefix("perms:v1:orgA:");

    expect(await cache.get("perms:v1:orgA:u1")).toBeNull();
    expect(await cache.get("perms:v1:orgA:u2")).toBeNull();
    expect(await cache.get("perms:v1:orgB:u9")).toBe(9);
    expect(await cache.get("identity:v1:u1")).toBe(7);
  });

  it("evicts oldest entries beyond maxEntries", async () => {
    const cache = new InMemoryCache({ maxEntries: 2 });
    await cache.set("a", 1, { ttlMs: 10_000 });
    await cache.set("b", 2, { ttlMs: 10_000 });
    await cache.set("c", 3, { ttlMs: 10_000 }); // evicts "a"
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("b")).toBe(2);
    expect(await cache.get("c")).toBe(3);
    expect(cache.size()).toBe(2);
  });

  it("a read refreshes recency so a hot key survives eviction", async () => {
    const cache = new InMemoryCache({ maxEntries: 2 });
    await cache.set("a", 1, { ttlMs: 10_000 });
    await cache.set("b", 2, { ttlMs: 10_000 });
    await cache.get("a"); // touch "a" → "b" is now oldest
    await cache.set("c", 3, { ttlMs: 10_000 }); // evicts "b"
    expect(await cache.get("a")).toBe(1);
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("c")).toBe(3);
  });
});
