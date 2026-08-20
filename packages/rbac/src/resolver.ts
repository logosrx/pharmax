// Effective permissions resolver.
//
// Resolves "what can THIS actor do in THIS context?" by:
//   1. Loading raw grants from the configured `EffectivePermissionLoader`.
//   2. Filtering grants by scope (drops grants whose pin doesn't match
//      the active context).
//   3. Unioning their permission sets into a single frozen `Set`.
//
// Caching strategy: WeakMap keyed on the TenancyContext object.
// Because every API request gets a fresh frozen TenancyContext via
// `buildTenancyContext`, the cache is implicitly request-scoped:
//   - Same context object → same cached set (no extra DB hit when
//     a command handler calls `requirePermission` multiple times).
//   - Next request → new context object → new entry, fresh load.
//   - Request completes → context goes out of scope → WeakMap GC's
//     the entry.
//
// What the cache does NOT do: live updates. If an admin revokes a
// role on the SAME context (i.e. the same in-flight request), the
// cached set is stale. This is acceptable — admin actions take
// effect on the NEXT request. If we ever need same-request
// invalidation, we expose a manual `invalidateContextCache(ctx)`
// helper; we don't today because no flow needs it.

import type { TenancyContext } from "@pharmax/tenancy";

import { appliesInContext, unionPermissions, type ResolvedGrant } from "./grants.js";
import type { EffectivePermissionLoader } from "./loader.js";
import type { PermissionCode } from "./permissions.js";

const cache = new WeakMap<TenancyContext, ReadonlySet<PermissionCode>>();
const grantCache = new WeakMap<TenancyContext, ReadonlyArray<ResolvedGrant>>();

/**
 * Load the actor's RAW grants for this context, cached per-context (same
 * lifecycle + GC semantics as the effective-set cache above). Exposed so
 * the scope-aware guards (`requirePermissionAnyScope` /
 * `requirePermissionForScope`) can evaluate grants against a resource
 * scope WITHOUT the session-context filter — and share a single load
 * with `resolveEffectivePermissions` when they run against the same
 * request context object (the bus passes one `ctx` through to the
 * factory, so the pre-lock and post-lock checks hit the cache, not the
 * database twice).
 */
export async function loadGrantsForContext(
  ctx: TenancyContext,
  loader: EffectivePermissionLoader
): Promise<ReadonlyArray<ResolvedGrant>> {
  const cached = grantCache.get(ctx);
  if (cached !== undefined) return cached;

  const grants: ReadonlyArray<ResolvedGrant> = await loader.load({
    organizationId: ctx.organizationId,
    userId: ctx.actor.userId,
  });
  grantCache.set(ctx, grants);
  return grants;
}

export async function resolveEffectivePermissions(
  ctx: TenancyContext,
  loader: EffectivePermissionLoader
): Promise<ReadonlySet<PermissionCode>> {
  const cached = cache.get(ctx);
  if (cached !== undefined) return cached;

  const grants = await loadGrantsForContext(ctx, loader);
  const applicable = grants.filter((g) => appliesInContext(g, ctx));
  const set = unionPermissions(applicable);
  const frozen: ReadonlySet<PermissionCode> = new Set(set);
  cache.set(ctx, frozen);
  return frozen;
}

/**
 * Drop the cached effective set for the given context. Test-only.
 * Production code should never need this; the WeakMap GC's entries
 * once the context goes out of scope.
 */
export function clearContextCacheForTests(ctx: TenancyContext): void {
  cache.delete(ctx);
  grantCache.delete(ctx);
}
