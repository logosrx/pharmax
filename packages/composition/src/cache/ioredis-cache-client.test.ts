// Tests for the ioredis → RedisLikeClient translation + the env-driven
// cache selection. The real ioredis connection is never opened here: the
// translation is exercised against a fake that records command shapes.

import { describe, expect, it, vi } from "vitest";

// Mock ioredis so createRedisCache can be exercised without opening a real
// connection. The registry captures each constructed instance.
const { redisInstances } = vi.hoisted(() => ({
  redisInstances: [] as Array<{
    url: string;
    options: Record<string, unknown>;
    on: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("ioredis", () => {
  class FakeRedis {
    public readonly on = vi.fn();
    public readonly quit = vi.fn(async () => "OK");
    public constructor(
      public readonly url: string,
      public readonly options: Record<string, unknown>
    ) {
      redisInstances.push(this as never);
    }
  }
  return { Redis: FakeRedis };
});

import { RedisCache } from "@pharmax/cache";
import type { logger as loggerTypes } from "@pharmax/platform-core";

import {
  createCacheFromEnv,
  createIoredisRedisClient,
  createRedisCache,
  type IoredisLike,
} from "./ioredis-cache-client.js";

function makeFakeRedis(initial: Record<string, string> = {}): IoredisLike & {
  store: Map<string, string>;
  set: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    unlink: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) removed += 1;
      }
      return removed;
    }),
    scan: vi.fn(async (_cursor: string, _m: "MATCH", pattern: string) => {
      const prefix = pattern.replace(/\*$/, "");
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      return ["0", keys] as [string, string[]];
    }),
    quit: vi.fn(async () => "OK"),
  };
}

describe("createIoredisRedisClient", () => {
  it("maps get to GET (null on miss)", async () => {
    const redis = makeFakeRedis({ "a:1": '"hit"' });
    const client = createIoredisRedisClient(redis);

    expect(await client.get("a:1")).toBe('"hit"');
    expect(await client.get("missing")).toBeNull();
  });

  it("maps set to SET key value PX ttlMs", async () => {
    const redis = makeFakeRedis();
    const client = createIoredisRedisClient(redis);

    await client.set("k", "v", 30_000);

    expect(redis.set).toHaveBeenCalledWith("k", "v", "PX", 30_000);
    expect(redis.store.get("k")).toBe("v");
  });

  it("maps del to UNLINK", async () => {
    const redis = makeFakeRedis({ k: "v" });
    const client = createIoredisRedisClient(redis);

    await client.del("k");

    expect(redis.unlink).toHaveBeenCalledWith("k");
    expect(redis.store.has("k")).toBe(false);
  });

  it("scanPrefix returns every key matching the prefix", async () => {
    const redis = makeFakeRedis({
      "perm:org1:u1": "x",
      "perm:org1:u2": "y",
      "identity:u3": "z",
    });
    const client = createIoredisRedisClient(redis);

    const keys = await client.scanPrefix("perm:org1:");

    expect([...keys].sort()).toEqual(["perm:org1:u1", "perm:org1:u2"]);
    expect(redis.scan).toHaveBeenCalledWith("0", "MATCH", "perm:org1:*", "COUNT", 200);
  });

  it("scanPrefix loops until the cursor returns to 0", async () => {
    // Two pages: cursor "0" -> "42" (batch 1), cursor "42" -> "0" (batch 2).
    const scan = vi
      .fn()
      .mockResolvedValueOnce(["42", ["p:1"]])
      .mockResolvedValueOnce(["0", ["p:2"]]);
    const redis: IoredisLike = {
      get: vi.fn(),
      set: vi.fn(),
      unlink: vi.fn(),
      scan,
      quit: vi.fn(),
    };
    const client = createIoredisRedisClient(redis);

    const keys = await client.scanPrefix("p:");

    expect(keys).toEqual(["p:1", "p:2"]);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenNthCalledWith(1, "0", "MATCH", "p:*", "COUNT", 200);
    expect(scan).toHaveBeenNthCalledWith(2, "42", "MATCH", "p:*", "COUNT", 200);
  });
});

describe("createCacheFromEnv", () => {
  it("returns a NoopCache (always-miss) when REDIS_URL is absent", async () => {
    const handle = createCacheFromEnv({ redisUrl: undefined });

    await handle.cache.set("k", { v: 1 }, { ttlMs: 1000 });
    expect(await handle.cache.get("k")).toBeNull();

    // close() is a safe no-op for the disabled cache.
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("treats an empty REDIS_URL as disabled", async () => {
    const handle = createCacheFromEnv({ redisUrl: "" });
    expect(await handle.cache.get("anything")).toBeNull();
    await handle.close();
  });

  it("returns a RedisCache when REDIS_URL is present", () => {
    const handle = createCacheFromEnv({ redisUrl: "rediss://:tok@host:6379" });
    expect(handle.cache).toBeInstanceOf(RedisCache);
  });
});

describe("createRedisCache", () => {
  it("constructs the client with fail-fast defaults and closes via quit", async () => {
    const handle = createRedisCache("rediss://:tok@host:6379");
    const instance = redisInstances.at(-1);

    expect(instance?.url).toBe("rediss://:tok@host:6379");
    expect(instance?.options.maxRetriesPerRequest).toBe(3);
    expect(instance?.options.enableReadyCheck).toBe(true);

    await handle.close();
    expect(instance?.quit).toHaveBeenCalledTimes(1);
  });

  it("logs transport errors when a logger is provided", () => {
    const warn = vi.fn();
    const logger = {
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    } as unknown as loggerTypes.Logger;

    createRedisCache("rediss://host:6379", { logger });
    const instance = redisInstances.at(-1);

    const errorHandler = instance?.on.mock.calls.find((c) => c[0] === "error")?.[1] as (
      e: Error
    ) => void;
    expect(errorHandler).toBeTypeOf("function");

    errorHandler(new Error("boom"));
    expect(warn).toHaveBeenCalledWith(
      "cache.redis.error",
      expect.objectContaining({ errorMessage: expect.stringContaining("boom") })
    );
  });
});
