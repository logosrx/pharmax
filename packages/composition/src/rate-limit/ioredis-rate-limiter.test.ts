// RedisRateLimiter — the happy path and, more importantly, the degraded
// path when Redis is unreachable.
//
// The degraded path is the reason this file exists. Before 2026-08-18 a
// transport error returned `{ allowed: true }`, which meant a Redis
// outage silently removed per-IP throttling from sign-in. Behaviour that
// only appears while a dependency is broken is exactly the behaviour
// nobody notices is wrong, so it gets its own tests.

import { describe, expect, it, vi } from "vitest";

import type { RateLimitRule } from "@pharmax/auth";

import {
  mergeRedisOptions,
  RedisRateLimiter,
  type IoredisEvalLike,
} from "./ioredis-rate-limiter.js";

const RULE: RateLimitRule = { limit: 3, windowMs: 60_000 };

/** Redis that returns a scripted [count, ttl] pair. */
function fakeRedis(reply: [number, number]): IoredisEvalLike {
  return {
    eval: vi.fn(async () => reply),
    quit: vi.fn(async () => "OK"),
  };
}

/** Redis whose every command rejects, as during an outage. */
function brokenRedis(error = new Error("ECONNREFUSED")): IoredisEvalLike {
  return {
    eval: vi.fn(async () => {
      throw error;
    }),
    quit: vi.fn(async () => "OK"),
  };
}

describe("RedisRateLimiter — Redis reachable", () => {
  it("allows while the count is within the limit", async () => {
    const limiter = new RedisRateLimiter(fakeRedis([2, 45_000]));
    expect(await limiter.hit("signin:ip:198.51.100.7", RULE)).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
  });

  it("denies past the limit and reports the window's remaining ttl", async () => {
    const limiter = new RedisRateLimiter(fakeRedis([4, 45_000]));
    expect(await limiter.hit("signin:ip:198.51.100.7", RULE)).toEqual({
      allowed: false,
      retryAfterMs: 45_000,
    });
  });

  it("falls back to the full window when the key reports no ttl", async () => {
    // PTTL returns -1 for a key with no expiry. Reporting `retryAfterMs: -1`
    // to a caller would be worse than useless — it would suggest retrying
    // immediately, forever.
    const limiter = new RedisRateLimiter(fakeRedis([9, -1]));
    expect(await limiter.hit("k", RULE)).toEqual({ allowed: false, retryAfterMs: 60_000 });
  });

  it("denies exactly at limit + 1, not at the limit", async () => {
    const atLimit = new RedisRateLimiter(fakeRedis([3, 10_000]));
    expect((await atLimit.hit("k", RULE)).allowed).toBe(true);
    const overLimit = new RedisRateLimiter(fakeRedis([4, 10_000]));
    expect((await overLimit.hit("k", RULE)).allowed).toBe(false);
  });
});

describe("RedisRateLimiter — Redis unreachable (degraded)", () => {
  it("still throttles rather than allowing everything", async () => {
    const limiter = new RedisRateLimiter(brokenRedis());

    // Three hits inside the limit.
    for (let i = 0; i < RULE.limit; i += 1) {
      expect((await limiter.hit("signin:ip:203.0.113.9", RULE)).allowed).toBe(true);
    }
    // The fourth is refused BY THE FALLBACK. Under the old blanket-allow
    // this assertion was impossible to write — every hit was allowed.
    const fourth = await limiter.hit("signin:ip:203.0.113.9", RULE);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("counts each key independently while degraded", async () => {
    const limiter = new RedisRateLimiter(brokenRedis());
    for (let i = 0; i < RULE.limit + 1; i += 1) {
      await limiter.hit("signin:ip:198.51.100.1", RULE);
    }
    // A different IP must not inherit the first one's exhausted budget —
    // otherwise one attacker degrades service for every operator.
    expect((await limiter.hit("signin:ip:198.51.100.2", RULE)).allowed).toBe(true);
  });

  it("keeps counting across repeated failures instead of resetting", async () => {
    // The fallback is constructed once per limiter, not per call. A
    // per-call instance would start a fresh window on every Redis error
    // and therefore throttle nothing at all during a sustained outage —
    // which would reproduce the original bug through a different route.
    const limiter = new RedisRateLimiter(brokenRedis());
    const results: boolean[] = [];
    for (let i = 0; i < RULE.limit + 2; i += 1) {
      results.push((await limiter.hit("k", RULE)).allowed);
    }
    expect(results.filter((allowed) => allowed)).toHaveLength(RULE.limit);
  });

  it("never fails closed — the first hit of an outage is allowed", async () => {
    // ADR-0030's availability requirement: a Redis outage must not lock
    // operators out. Degrading must not become denying.
    const limiter = new RedisRateLimiter(brokenRedis());
    expect((await limiter.hit("fresh-key", RULE)).allowed).toBe(true);
  });

  it("logs the degradation so an outage is visible, without PHI", async () => {
    const warn = vi.fn();
    const limiter = new RedisRateLimiter(brokenRedis(new Error("connect ETIMEDOUT")), {
      warn,
    } as never);

    await limiter.hit("signin:email:someone@example.test", RULE);

    expect(warn).toHaveBeenCalledWith(
      "auth.rate_limit.redis_error_degraded",
      expect.objectContaining({ errorMessage: "Error: connect ETIMEDOUT" })
    );
    // The rate-limit key embeds an email on the per-email path. It must
    // not reach the log line.
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("someone@example.test");
  });

  it("accepts an injected fallback so callers can share one across limiters", async () => {
    const shared = { hit: vi.fn(async () => ({ allowed: false, retryAfterMs: 1_234 })) };
    const limiter = new RedisRateLimiter(brokenRedis(), undefined, shared);
    expect(await limiter.hit("k", RULE)).toEqual({ allowed: false, retryAfterMs: 1_234 });
    expect(shared.hit).toHaveBeenCalledWith("k", RULE);
  });
});

describe("mergeRedisOptions", () => {
  it("applies the fail-fast defaults when no overrides are given", () => {
    expect(mergeRedisOptions(undefined)).toEqual({
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
  });

  it("lets a caller override a default", () => {
    expect(mergeRedisOptions({ maxRetriesPerRequest: 1 })).toEqual({
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
  });

  it("keeps caller-only options alongside the defaults", () => {
    expect(mergeRedisOptions({ connectTimeout: 250 })).toEqual({
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 250,
    });
  });
});
