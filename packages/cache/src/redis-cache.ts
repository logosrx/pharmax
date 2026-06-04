// Redis-backed cache adapter (port-based).
//
// `@pharmax/cache` deliberately carries NO concrete Redis dependency.
// Instead this adapter targets a narrow `RedisLikeClient` port that the
// composition layer satisfies with a thin wrapper over whichever client
// the deployment uses (ioredis, node-redis, a Valkey client, ...). That
// keeps this package leaf + fully unit-testable with a fake, and lets
// the runtime client be wired (and its connection lifecycle managed)
// where `REDIS_URL` and the feature flag are read.
//
// Values are JSON strings on the wire — identical fidelity to the
// in-memory adapter. TTL is applied per `set`, so a missed explicit
// invalidation still self-heals when the key expires.

import type { Cache, CacheSetOptions } from "./cache.js";

/**
 * Minimal Redis surface this adapter needs. Map each method to the
 * concrete client in the composition layer:
 *
 *   - `get`        → GET
 *   - `set`        → SET key value PX <ttlMs>
 *   - `del`        → DEL / UNLINK
 *   - `scanPrefix` → a SCAN loop over `MATCH ${prefix}*` (NEVER `KEYS`,
 *                    which blocks the server on large keyspaces).
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  /** Store with a millisecond TTL (maps to `SET key value PX ttlMs`). */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Return every key matching `${prefix}*` (SCAN-based, not KEYS). */
  scanPrefix(prefix: string): Promise<ReadonlyArray<string>>;
}

export class RedisCache implements Cache {
  public constructor(private readonly client: RedisLikeClient) {}

  public async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  public async set<T>(key: string, value: T, options: CacheSetOptions): Promise<void> {
    await this.client.set(key, JSON.stringify(value), options.ttlMs);
  }

  public async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  public async deletePrefix(prefix: string): Promise<void> {
    const keys = await this.client.scanPrefix(prefix);
    for (const key of keys) {
      await this.client.del(key);
    }
  }
}
