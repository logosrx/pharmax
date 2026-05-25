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

export async function resolveEffectivePermissions(
  ctx: TenancyContext,
  loader: EffectivePermissionLoader
): Promise<ReadonlySet<PermissionCode>> {
  const cached = cache.get(ctx);
  if (cached !== undefined) return cached;

  const grants: ReadonlyArray<ResolvedGrant> = await loader.load({
    organizationId: ctx.organizationId,
    userId: ctx.actor.userId,
  });
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
}
