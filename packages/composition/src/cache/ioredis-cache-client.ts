// Concrete ioredis-backed cache wiring.
//
// `@pharmax/cache` deliberately ships only the `Cache` port + adapters
// (RedisCache, InMemoryCache, NoopCache) with NO concrete Redis dependency,
// and its `RedisLikeClient` doc says to map the port "to the concrete client
// in the composition layer". This is that layer: it owns the `ioredis`
// dependency, the connection lifecycle, and the REDIS_URL → Cache decision.
//
// Wire-format + TTL semantics are defined by RedisCache (JSON values, PX
// TTL). Here we only translate the narrow `RedisLikeClient` methods onto
// ioredis commands:
//   - get        → GET
//   - set        → SET key value PX <ttlMs>
//   - del        → UNLINK (non-blocking DEL)
//   - scanPrefix → cursor SCAN loop over `MATCH ${prefix}*` (never KEYS,
//                  which blocks the server on a large keyspace)

import { NoopCache, RedisCache, type Cache, type RedisLikeClient } from "@pharmax/cache";
import type { logger as loggerTypes } from "@pharmax/platform-core";
import { Redis, type RedisOptions } from "ioredis";

type Logger = loggerTypes.Logger;

/**
 * The minimal ioredis surface this adapter uses. Declared narrowly so the
 * translation is unit-testable with a fake; the real `Redis` instance is
 * structurally compatible and passed through a cast at the construction
 * boundary.
 */
export interface IoredisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  unlink(...keys: string[]): Promise<number>;
  scan(
    cursor: string,
    matchToken: "MATCH",
    pattern: string,
    countToken: "COUNT",
    count: number
  ): Promise<[string, string[]]>;
  quit(): Promise<unknown>;
}

// SCAN page size. Large enough to keep round-trips low on a modest keyspace,
// small enough that a single SCAN never blocks the event loop materially.
const SCAN_COUNT = 200;

/**
 * Adapt a (real or fake) ioredis client to the `RedisLikeClient` port that
 * `RedisCache` consumes.
 */
export function createIoredisRedisClient(redis: IoredisLike): RedisLikeClient {
  return {
    async get(key: string): Promise<string | null> {
      return redis.get(key);
    },

    async set(key: string, value: string, ttlMs: number): Promise<void> {
      await redis.set(key, value, "PX", ttlMs);
    },

    async del(key: string): Promise<void> {
      await redis.unlink(key);
    },

    async scanPrefix(prefix: string): Promise<ReadonlyArray<string>> {
      const matched: string[] = [];
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", SCAN_COUNT);
        matched.push(...keys);
        cursor = next;
      } while (cursor !== "0");
      return matched;
    },
  };
}

/** A live cache plus the handle to close its underlying connection. */
export interface RedisCacheHandle {
  readonly cache: Cache;
  /** Quit the underlying Redis connection. Call during graceful shutdown. */
  close(): Promise<void>;
}

export interface CreateRedisCacheOptions {
  /** When set, transport errors are logged (warn) instead of being silent. */
  readonly logger?: Logger;
  /** Extra ioredis options merged over the defaults. */
  readonly redisOptions?: RedisOptions;
}

/**
 * Build a `RedisCache` backed by a fresh ioredis connection.
 *
 * ioredis auto-enables TLS for `rediss://` URLs and reads the AUTH token
 * from the URL's password component, so an ElastiCache URL of the form
 * `rediss://:<auth_token>@<primary>:6379` needs no extra configuration.
 */
export function createRedisCache(
  redisUrl: string,
  options: CreateRedisCacheOptions = {}
): RedisCacheHandle {
  const redis = new Redis(redisUrl, {
    // Fail commands fast on a wedged connection rather than queueing them
    // unbounded — the cache is a shortcut, callers fall through to the DB.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    ...options.redisOptions,
  });

  const { logger } = options;
  if (logger !== undefined) {
    redis.on("error", (error: Error) => {
      logger.warn("cache.redis.error", { errorMessage: `${error.name}: ${error.message}` });
    });
  }

  const client = createIoredisRedisClient(redis as unknown as IoredisLike);
  return {
    cache: new RedisCache(client),
    async close(): Promise<void> {
      await redis.quit();
    },
  };
}

export interface CreateCacheFromEnvInput {
  /** The REDIS_URL value (rediss://...). When absent/empty, the cache is disabled. */
  readonly redisUrl?: string | undefined;
  readonly logger?: Logger;
}

/**
 * Pick the cache implementation from the environment:
 *   - REDIS_URL present → shared `RedisCache` over ioredis.
 *   - REDIS_URL absent  → `NoopCache` (every read misses, so callers
 *     transparently resolve from the database; see @pharmax/cache `cached()`).
 *
 * The returned `close()` is a no-op for the NoopCache branch, so callers can
 * always wire it into shutdown unconditionally.
 */
export function createCacheFromEnv(input: CreateCacheFromEnvInput): RedisCacheHandle {
  if (typeof input.redisUrl === "string" && input.redisUrl.length > 0) {
    return createRedisCache(
      input.redisUrl,
      input.logger !== undefined ? { logger: input.logger } : {}
    );
  }
  return {
    cache: new NoopCache(),
    async close(): Promise<void> {
      // No connection to close for the disabled cache.
    },
  };
}
