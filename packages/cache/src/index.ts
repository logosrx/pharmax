// Public surface of @pharmax/cache.
//
// A provider-agnostic caching layer for cross-request reuse of
// near-immutable, expensive-to-resolve values (e.g. the Clerk→Pharmax
// identity mapping, the RBAC permission set). The design keeps the
// cache strictly a performance shortcut: correctness always traces to
// the database via the `cached()` read-through, every entry has a TTL
// safety net, and negative results are never cached.
//
//   - `Cache`               the port every adapter implements.
//   - `NoopCache`           the disabled default (feature flag off).
//   - `InMemoryCache`       in-process adapter (dev/test/single node).
//   - `RedisCache`          shared adapter over an injected client port.
//   - `cached()`            safe read-through (degrades to the loader).
//   - `cacheKey()`          namespaced + versioned key builder.

export type { Cache, CacheSetOptions } from "./cache.js";
export { NoopCache } from "./noop-cache.js";
export { InMemoryCache, type InMemoryCacheOptions } from "./in-memory-cache.js";
export { RedisCache, type RedisLikeClient } from "./redis-cache.js";
export { cached, cacheKey, type CachedOptions } from "./cached.js";
