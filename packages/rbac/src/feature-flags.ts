// FeatureFlagSource — the per-tenant resolver for feature codes.
//
// Mirrors the EffectivePermissionLoader split: the SOURCE knows how
// to ask the database (or Redis cache, or in-memory test fixture); the
// resolver caches by TenancyContext. Production wires a Prisma-backed
// source against a `feature_flag` table (lands in Phase 2 with the
// patient/order schema migration). Tests wire `InMemoryFeatureFlagSource`.
//
// Resolution rule:
//   1. Look up `(organizationId, featureCode)` in the source.
//   2. If a row exists, return its value (true/false).
//   3. If no row exists, return `FEATURE_METADATA[code].defaultEnabled`.
//
// This three-state model (explicit-true / explicit-false / unset →
// default) lets us add new features without backfilling rows for
// every tenant: the default kicks in until the admin toggles it.
//
// Performance: the resolver fetches ALL features for the tenant in one
// call and caches the resulting map on the TenancyContext WeakMap, so
// repeated `hasFeature` checks in a command handler are O(1) after
// the first.

import type { TenancyContext } from "@pharmax/tenancy";

import { ALL_FEATURE_CODES, FEATURE_METADATA, type FeatureCode } from "./features.js";

export interface FeatureFlagLoadInput {
  readonly organizationId: string;
}

export interface FeatureFlagSource {
  /**
   * Returns a map of EXPLICITLY-set feature values for the tenant.
   * Unset features are NOT in the returned map; the resolver applies
   * `defaultEnabled` from `FEATURE_METADATA`.
   */
  load(input: FeatureFlagLoadInput): Promise<ReadonlyMap<FeatureCode, boolean>>;
}

/**
 * In-memory source for tests. Construct with a literal map of
 * `(organizationId, FeatureCode → boolean)`. Tenants with no entry
 * get the metadata defaults.
 */
export class InMemoryFeatureFlagSource implements FeatureFlagSource {
  private readonly byTenant: ReadonlyMap<string, ReadonlyMap<FeatureCode, boolean>>;

  public constructor(
    entries: ReadonlyArray<{
      readonly organizationId: string;
      readonly flags: ReadonlyMap<FeatureCode, boolean> | Readonly<Record<string, boolean>>;
    }>
  ) {
    const map = new Map<string, ReadonlyMap<FeatureCode, boolean>>();
    for (const entry of entries) {
      const flags =
        entry.flags instanceof Map
          ? (entry.flags as ReadonlyMap<FeatureCode, boolean>)
          : recordToMap(entry.flags as Readonly<Record<string, boolean>>);
      map.set(entry.organizationId, flags);
    }
    this.byTenant = map;
  }

  public async load(input: FeatureFlagLoadInput): Promise<ReadonlyMap<FeatureCode, boolean>> {
    return this.byTenant.get(input.organizationId) ?? new Map();
  }
}

function recordToMap(rec: Readonly<Record<string, boolean>>): ReadonlyMap<FeatureCode, boolean> {
  const out = new Map<FeatureCode, boolean>();
  for (const [k, v] of Object.entries(rec)) {
    if ((ALL_FEATURE_CODES as ReadonlyArray<string>).includes(k)) {
      out.set(k as FeatureCode, v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolver (per-context cache).
// ---------------------------------------------------------------------------

const featureCache = new WeakMap<TenancyContext, ReadonlyMap<FeatureCode, boolean>>();

/**
 * Returns the effective feature map for the active tenant, applying
 * `defaultEnabled` for any unset feature. Cached on the
 * `TenancyContext` object via WeakMap (same lifecycle as the
 * permission resolver — implicitly request-scoped).
 */
export async function resolveEffectiveFeatures(
  ctx: TenancyContext,
  source: FeatureFlagSource
): Promise<ReadonlyMap<FeatureCode, boolean>> {
  const cached = featureCache.get(ctx);
  if (cached !== undefined) return cached;

  const explicit = await source.load({ organizationId: ctx.organizationId });
  const out = new Map<FeatureCode, boolean>();
  for (const code of ALL_FEATURE_CODES) {
    out.set(code, explicit.get(code) ?? FEATURE_METADATA[code].defaultEnabled);
  }
  const frozen: ReadonlyMap<FeatureCode, boolean> = out;
  featureCache.set(ctx, frozen);
  return frozen;
}

/**
 * Test-only: drop the cached feature map for a context. The WeakMap
 * GC's entries when the context goes out of scope, but tests that
 * reuse a context across mutations need an explicit reset.
 */
export function clearFeatureCacheForTests(ctx: TenancyContext): void {
  featureCache.delete(ctx);
}
