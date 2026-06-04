// In-process cache adapter.
//
// Backs single-instance deployments, local dev, and tests. For a
// multi-instance production fleet prefer the Redis adapter so all
// instances share one view (and one invalidation) — but even a
// per-instance in-memory cache with a short TTL meaningfully cuts
// database load for hot keys, and it is a safe fallback when Redis is
// unavailable.
//
// Semantics mirror the Redis adapter exactly: values are stored as
// JSON strings (so a round trip has identical fidelity to Redis), a
// monotonic-ish wall clock drives TTL expiry, and a bounded entry
// count protects process memory with simple insertion-order (≈LRU)
// eviction.

import type { Cache, CacheSetOptions } from "./cache.js";

interface Entry {
  /** JSON-serialized value — parity with the Redis adapter. */
  readonly json: string;
  /** Epoch ms at which the entry is considered expired. */
  readonly expiresAt: number;
}

export interface InMemoryCacheOptions {
  /**
   * Hard cap on stored entries. When exceeded, the oldest-inserted
   * entries are evicted first (Map preserves insertion order; a read
   * re-inserts to approximate LRU). Defaults to 10,000.
   */
  readonly maxEntries?: number;
  /** Injectable clock for deterministic TTL tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class InMemoryCache implements Cache {
  private readonly store = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  public constructor(options: InMemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? ((): number => Date.now());
  }

  public async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    // LRU touch: delete + re-insert moves the key to the most-recent
    // position so it survives eviction longer than colder keys.
    this.store.delete(key);
    this.store.set(key, entry);
    return JSON.parse(entry.json) as T;
  }

  public async set<T>(key: string, value: T, options: CacheSetOptions): Promise<void> {
    // Serialize on write so a later mutation of the caller's object
    // cannot retroactively change the cached value (and so fidelity
    // matches the Redis adapter exactly).
    const json = JSON.stringify(value);
    this.store.delete(key);
    this.store.set(key, { json, expiresAt: this.now() + options.ttlMs });
    this.evictIfNeeded();
  }

  public async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  public async deletePrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /** Test/diagnostic helper — current entry count (incl. not-yet-swept expired). */
  public size(): number {
    return this.store.size;
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}
