// Process-wide cache singleton for the web tier.
//
// `createCacheFromEnv` returns a `RedisCache` over ioredis when `REDIS_URL`
// is set (production, backed by the ElastiCache replication group), and a
// `NoopCache` (always-miss → callers fall through to the DB) otherwise —
// so dev/test clones and any deployment without Redis behave correctly,
// just without the cross-request hit.
//
// The handle is built lazily on first use and reused for the life of the
// process. There is intentionally no eager wiring in bootstrap.ts: the
// cache is a pure performance shortcut (never a source of truth), so a
// missing/broken Redis must never block boot — `cached()` degrades to the
// loader on any transport error.

import "server-only";

import { createCacheFromEnv, type Cache, type RedisCacheHandle } from "@pharmax/composition";

import { env } from "./env.js";
import { logger } from "./logger.js";

let handle: RedisCacheHandle | null = null;

function getServerCacheHandle(): RedisCacheHandle {
  if (handle === null) {
    handle = createCacheFromEnv({ redisUrl: env.REDIS_URL, logger });
  }
  return handle;
}

/** The shared `Cache` for cross-request reuse (identity, permissions). */
export function getServerCache(): Cache {
  return getServerCacheHandle().cache;
}

/**
 * Close the underlying Redis connection (graceful shutdown). No-op when the
 * cache was never built or is the NoopCache. A future ECS pre-stop hook can
 * call this; the web tier has no explicit signal phase today.
 */
export async function closeServerCache(): Promise<void> {
  if (handle !== null) {
    await handle.close();
    handle = null;
  }
}
