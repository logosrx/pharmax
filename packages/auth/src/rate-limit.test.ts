import { describe, expect, it } from "vitest";

import { InMemoryRateLimiter, NOOP_RATE_LIMITER, type RateLimitRule } from "./rate-limit.js";

const RULE: RateLimitRule = { limit: 3, windowMs: 60_000 };

describe("InMemoryRateLimiter", () => {
  it("allows hits up to the limit, then blocks", async () => {
    const rl = new InMemoryRateLimiter(() => 1_000);
    expect((await rl.hit("k", RULE)).allowed).toBe(true); // 1
    expect((await rl.hit("k", RULE)).allowed).toBe(true); // 2
    expect((await rl.hit("k", RULE)).allowed).toBe(true); // 3
    const blocked = await rl.hit("k", RULE); // 4
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(RULE.windowMs);
  });

  it("keeps separate counters per key", async () => {
    const rl = new InMemoryRateLimiter(() => 1_000);
    await rl.hit("a", RULE);
    await rl.hit("a", RULE);
    await rl.hit("a", RULE);
    expect((await rl.hit("a", RULE)).allowed).toBe(false);
    // A different key is unaffected.
    expect((await rl.hit("b", RULE)).allowed).toBe(true);
  });

  it("resets after the window elapses", async () => {
    let now = 1_000;
    const rl = new InMemoryRateLimiter(() => now);
    for (let i = 0; i < RULE.limit; i += 1) await rl.hit("k", RULE);
    expect((await rl.hit("k", RULE)).allowed).toBe(false);
    now += RULE.windowMs + 1; // window elapsed
    expect((await rl.hit("k", RULE)).allowed).toBe(true);
  });

  it("blocks immediately when limit is zero", async () => {
    const rl = new InMemoryRateLimiter(() => 1_000);
    expect((await rl.hit("k", { limit: 0, windowMs: 1_000 })).allowed).toBe(false);
  });
});

describe("NOOP_RATE_LIMITER", () => {
  it("always allows", async () => {
    for (let i = 0; i < 100; i += 1) {
      expect((await NOOP_RATE_LIMITER.hit("k", { limit: 1, windowMs: 1 })).allowed).toBe(true);
    }
  });
});
