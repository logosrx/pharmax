// EffectivePermissionLoader — the interface the resolver uses to
// fetch a user's grants.
//
// We define an INTERFACE here (not a concrete Prisma call) so that
// the resolver, the guard, and all tests can swap implementations
// without touching any production code:
//
//   - Production: `PrismaPermissionLoader` (one raw join, returned
//     as `ResolvedGrant[]`).
//   - Tests: `InMemoryPermissionLoader` (literal array; no I/O).
//   - Future: a cached/redis-backed loader can drop in without
//     changing call sites if we ever need cross-request caching
//     for an extremely hot user (e.g. a system actor running
//     scheduled jobs).
//
// The loader is intentionally cache-FREE. Caching lives one level
// up in the resolver (keyed on the active TenancyContext via
// WeakMap), so it's tied to the request lifecycle and invalidates
// implicitly when the request ends.

import type { ResolvedGrant } from "./grants.js";

export interface PermissionLoadInput {
  readonly organizationId: string;
  readonly userId: string;
}

export interface EffectivePermissionLoader {
  load(input: PermissionLoadInput): Promise<ReadonlyArray<ResolvedGrant>>;
}

/**
 * In-memory loader for tests. Construct with a literal list of
 * grants keyed by (organizationId, userId). Returns the matching
 * subset; unrecognized callers see an empty grant set (which the
 * guard treats as "no permissions" → deny everything).
 */
export class InMemoryPermissionLoader implements EffectivePermissionLoader {
  private readonly grants: ReadonlyMap<string, ReadonlyArray<ResolvedGrant>>;

  public constructor(
    entries: ReadonlyArray<{
      readonly organizationId: string;
      readonly userId: string;
      readonly grants: ReadonlyArray<ResolvedGrant>;
    }>
  ) {
    const map = new Map<string, ReadonlyArray<ResolvedGrant>>();
    for (const entry of entries) {
      map.set(key(entry.organizationId, entry.userId), entry.grants);
    }
    this.grants = map;
  }

  public async load(input: PermissionLoadInput): Promise<ReadonlyArray<ResolvedGrant>> {
    return this.grants.get(key(input.organizationId, input.userId)) ?? [];
  }
}

function key(organizationId: string, userId: string): string {
  return `${organizationId}::${userId}`;
}
