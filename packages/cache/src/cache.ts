// The provider-agnostic cache port.
//
// `@pharmax/cache` exists so the rest of the platform can add a
// cross-request cache (e.g. the near-immutable Clerk→user identity
// mapping) WITHOUT coupling to a concrete Redis client. Application
// code depends on this `Cache` interface; the composition layer wires
// the concrete adapter (in-memory for dev/test/single-instance, Redis
// for multi-instance production).
//
// Design invariants every adapter MUST uphold:
//
//   - Values are JSON-serializable. Adapters round-trip through
//     `JSON.stringify`/`JSON.parse` so semantics are identical across
//     in-memory and Redis (a `Date` becomes its ISO string, etc.).
//     Callers cache plain data (ids, strings, string[]), never class
//     instances or functions.
//   - `get` returns `null` for BOTH "absent" and "expired". A stored
//     value is therefore never `null` — see `cached()` which refuses
//     to write `null`/`undefined` so a miss and a cached-null can
//     never be confused (no negative caching).
//   - TTL is mandatory on `set`. There is no "cache forever": every
//     entry self-heals after `ttlMs` even if an explicit invalidation
//     is missed. This is the safety net that bounds staleness.
//   - The cache is a PERFORMANCE shortcut, never a source of truth.
//     Callers MUST resolve the authoritative value from the database
//     on a miss; see `cached()` for the safe read-through pattern that
//     degrades to the loader on any cache error.

export interface CacheSetOptions {
  /**
   * Time-to-live in milliseconds. Required — every entry expires so a
   * missed invalidation self-heals within `ttlMs`. Keep small for
   * security-sensitive values (identity/permissions).
   */
  readonly ttlMs: number;
}

export interface Cache {
  /**
   * Resolve a previously-cached value, or `null` when absent/expired.
   * MUST NOT throw for a miss — only for an underlying transport
   * failure, which callers treat as a miss (see `cached()`).
   */
  get<T>(key: string): Promise<T | null>;

  /** Store `value` under `key` for `options.ttlMs` milliseconds. */
  set<T>(key: string, value: T, options: CacheSetOptions): Promise<void>;

  /** Remove a single key. No-op when the key is absent. */
  delete(key: string): Promise<void>;

  /**
   * Remove every key beginning with `prefix`. For coarse invalidation
   * (e.g. "drop every cached permission set for org X" after a
   * role-template change). Rare relative to single-key deletes; Redis
   * adapters SHOULD implement it with `SCAN`, never the blocking
   * `KEYS` command.
   */
  deletePrefix(prefix: string): Promise<void>;
}
