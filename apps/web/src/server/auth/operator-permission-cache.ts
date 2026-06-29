// Operator-permission cache: the (organizationId, userId) → effective
// RBAC grants mapping.
//
// Every operator page/route resolves the actor's effective permission
// set (`loadOperatorPermissions` → `resolveEffectivePermissions`),
// which loads the user's grants via a four-table join
// (user_role → role → role_permission → permission). The resolver
// already memoizes per-request (a WeakMap keyed on the TenancyContext),
// but back-to-back NAVIGATIONS by the same operator each re-ran the
// join. This module caches the LOADER output across requests so a hot
// operator's navigation skips that join.
//
// WHAT IS CACHED (and why this is correct): the raw `ResolvedGrant[]`
// for (org, user) — NOT the final permission set. The resolver still
// filters those grants by the active context's scope
// (`appliesInContext`) on every request, so site/clinic/team scoping
// stays dynamic and correct; only the DB load is shortcut.
//
// SAFETY MODEL (grants are authz-relevant, so staleness is bounded):
//
//   - SHORT TTL (`OPERATOR_PERMISSION_CACHE_TTL_MS`) — the self-healing
//     safety net; the worst-case window if an invalidation is missed.
//   - EXPLICIT invalidation on every grant mutation: `AssignRole` and
//     `RevokeUserRole` are the ONLY commands that change a user's
//     user_role rows (role_permission is seed-only, never mutated at
//     runtime), and both dispatch routes invalidate this key on
//     success. A revoked role stops granting access immediately.
//   - `cached()` degrades to the authoritative loader on any cache
//     transport error — the cache is never a source of truth.
//
// GATING: the cache instance is `getServerCache()` — a `RedisCache`
// when `REDIS_URL` is set, a `NoopCache` (always-miss → loader runs)
// otherwise. So this is off by default (dev/test/no-Redis behave
// exactly as before) and shares the same backing store + lifecycle as
// the identity cache.
//
// PHI invariant: grants + permission codes are non-PHI by definition.

import "server-only";

import { cached, cacheKey, type Cache } from "@pharmax/composition";
import type { RoleScope } from "@pharmax/database";
import type {
  EffectivePermissionLoader,
  PermissionCode,
  PermissionLoadInput,
  ResolvedGrant,
} from "@pharmax/rbac";

import { getServerCache } from "../cache.js";
import { logger } from "../logger.js";

/**
 * TTL for cached operator grants. Short because grants are
 * authz-relevant; bounds the worst-case window in which a revoked role
 * could still grant access if an explicit invalidation were missed.
 * Explicit invalidation (the role routes) is the primary mechanism;
 * this is the safety net. Mirrors the identity cache's 30s.
 */
export const OPERATOR_PERMISSION_CACHE_TTL_MS = 30_000;

/**
 * JSON-serializable projection of a `ResolvedGrant`. The cache round-
 * trips through JSON, which cannot represent a `Set`, so the grant's
 * `permissions` set is stored as a string array and rehydrated on read.
 */
export interface SerializableGrant {
  readonly roleScope: RoleScope;
  readonly grantScope: {
    readonly siteId: string | null;
    readonly clinicId: string | null;
    readonly teamId: string | null;
  };
  readonly permissions: ReadonlyArray<string>;
}

/** Namespaced, versioned cache key for one operator's grants. */
export function operatorPermissionCacheKey(organizationId: string, userId: string): string {
  return cacheKey("operator-permissions", 1, organizationId, userId);
}

/** `ResolvedGrant[]` → JSON-safe form (Set → array). */
export function serializeGrants(grants: ReadonlyArray<ResolvedGrant>): SerializableGrant[] {
  return grants.map((grant) => ({
    roleScope: grant.roleScope,
    grantScope: {
      siteId: grant.grantScope.siteId,
      clinicId: grant.grantScope.clinicId,
      teamId: grant.grantScope.teamId,
    },
    permissions: [...grant.permissions],
  }));
}

/** JSON-safe form → `ResolvedGrant[]` (array → Set). */
export function deserializeGrants(serialized: ReadonlyArray<SerializableGrant>): ResolvedGrant[] {
  return serialized.map((grant) => ({
    roleScope: grant.roleScope,
    grantScope: {
      siteId: grant.grantScope.siteId,
      clinicId: grant.grantScope.clinicId,
      teamId: grant.grantScope.teamId,
    },
    permissions: new Set(grant.permissions as ReadonlyArray<PermissionCode>),
  }));
}

/**
 * A read-through caching decorator over any `EffectivePermissionLoader`.
 * The `loader.ts` design note explicitly anticipates this ("a cached/
 * redis-backed loader can drop in without changing call sites"). It
 * caches the serialized grants per (org, user); the resolver applies
 * context-scope filtering on the rehydrated grants as before.
 */
export class CachedPermissionLoader implements EffectivePermissionLoader {
  public constructor(
    private readonly inner: EffectivePermissionLoader,
    private readonly cache: Cache
  ) {}

  public async load(input: PermissionLoadInput): Promise<ReadonlyArray<ResolvedGrant>> {
    const serialized = await cached<SerializableGrant[]>({
      cache: this.cache,
      key: operatorPermissionCacheKey(input.organizationId, input.userId),
      ttlMs: OPERATOR_PERMISSION_CACHE_TTL_MS,
      load: async () => serializeGrants(await this.inner.load(input)),
      onError: (stage, error) => {
        // Transport failure is non-fatal — `cached()` already fell
        // through to the loader. Log for metrics only.
        logger.warn("auth.operator_permission_cache.error", {
          stage,
          errorMessage: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
        });
      },
    });
    return deserializeGrants(serialized);
  }
}

/**
 * Drop the cached grants for one operator. Called by the role-mutation
 * routes (`AssignRole` / `RevokeUserRole`) on success. Best-effort: a
 * transport error is swallowed because the short TTL is the safety net
 * and a failed invalidation must never break the role-change request.
 *
 * `cache` is injectable for tests; production uses the process singleton.
 */
export async function invalidateOperatorPermissionCache(
  organizationId: string,
  userId: string,
  options: { readonly cache?: Cache } = {}
): Promise<void> {
  const cache = options.cache ?? getServerCache();
  try {
    await cache.delete(operatorPermissionCacheKey(organizationId, userId));
  } catch {
    // Intentionally swallowed — TTL bounds staleness; invalidation is
    // an optimization on top of it.
  }
}
