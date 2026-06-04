// Safe read-through helper + key builder.
//
// `cached()` is the ONLY pattern application code should use to read a
// cache. Its contract is the safety property that makes a cache on a
// sensitive path acceptable:
//
//   The cache is a PERFORMANCE shortcut, never a source of truth.
//
//   - On a hit, the cached value is returned.
//   - On a miss, the authoritative `load()` (the DB read) runs and its
//     result is written back.
//   - On ANY cache transport error (get OR set), the error is reported
//     to `onError` and `load()` is used. A cache outage therefore costs
//     latency, never correctness.
//   - `null`/`undefined` results are NEVER written. This forbids
//     negative caching — a "not found" / "not linked" answer is always
//     re-resolved from the DB, so a just-provisioned operator is never
//     locked out by a cached negative.
//
// Combined with a short TTL (the self-healing safety net) and explicit
// `delete` on the mutation paths (webhooks / role commands), this keeps
// the worst-case staleness window bounded and small.

import type { Cache } from "./cache.js";

export interface CachedOptions<T> {
  readonly cache: Cache;
  readonly key: string;
  readonly ttlMs: number;
  /** The authoritative loader. Runs on a miss or any cache error. */
  readonly load: () => Promise<T>;
  /**
   * Observe cache failures. The result is ALWAYS resolved from `load`
   * when this fires, so this is for metrics/logging only — never for
   * changing control flow.
   */
  readonly onError?: (stage: "get" | "set", error: unknown) => void;
}

export async function cached<T>(options: CachedOptions<T>): Promise<T> {
  try {
    const hit = await options.cache.get<T>(options.key);
    if (hit !== null) return hit;
  } catch (error) {
    options.onError?.("get", error);
    // Fall through to the authoritative loader.
  }

  const value = await options.load();

  // Never negatively cache: a null/undefined result is re-resolved
  // from the source of truth on the next call.
  if (value !== null && value !== undefined) {
    try {
      await options.cache.set<T>(options.key, value, { ttlMs: options.ttlMs });
    } catch (error) {
      options.onError?.("set", error);
    }
  }

  return value;
}

/**
 * Build a namespaced, versioned cache key. The version segment lets a
 * shape change be rolled out by bumping it (old keys simply age out via
 * TTL — no manual flush needed).
 *
 *   cacheKey("identity", 1, clerkUserId)  → "identity:v1:user_2ab…"
 *   cacheKey("perms", 1, orgId, userId)   → "perms:v1:org…:user…"
 *
 * The trailing prefix form (omit the final part) pairs with
 * `Cache.deletePrefix` for coarse invalidation, e.g.
 * `cacheKey("perms", 1, orgId) + ":"` removes every user's perms in
 * that org.
 */
export function cacheKey(
  namespace: string,
  version: number,
  ...parts: ReadonlyArray<string>
): string {
  const suffix = parts.length > 0 ? `:${parts.join(":")}` : "";
  return `${namespace}:v${version}${suffix}`;
}
