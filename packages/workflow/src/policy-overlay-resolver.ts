// Per-tenant overlay resolver — Tier 2 ACTIVATION.
//
// This module is the SEAM between the command bus's per-tx policy
// load and the per-tenant overlay rows. The bus calls
// `resolvePolicyForTenant` inside step 11 (right after the base
// policy row is loaded by `defineCommand`); the result is the
// `MergedWorkflowPolicy` snapshot that step 12 (validate
// prerequisites), step 14 (update order status) and step 18
// (write event_outbox) all read.
//
// Why a process-local cache:
//
//   The overlay table is read on EVERY tenant command. With ~10k
//   commands/day per tenant and ~5–10 active overlays per tenant,
//   the steady-state hit rate for the cache approaches 1.0. A 30s
//   TTL bounds how long a stale snapshot can survive after an
//   activation; admins are told the propagation window in the
//   RUNBOOK ("expect new overlay activation to take effect within
//   30 seconds across all workers").
//
//   The cache is process-local. Each worker warms independently
//   on first miss. Activation invalidations (via
//   `invalidatePolicyCache`) are local to the process executing
//   the activation; sibling workers see the change after their
//   own TTL expires. Stale-by-30s is the explicit acceptance.
//
// Snapshot semantic (load-bearing):
//
//   The cache stores `MergedWorkflowPolicy` objects. Once captured,
//   those objects are FROZEN (`buildMergedPolicy` returns frozen).
//   A command that has already extracted its snapshot from the
//   cache is unaffected by any subsequent invalidation —
//   mid-flight commands keep their pre-activation snapshot. This
//   is the in-flight grandfather rule (ADR 0019 §3) implemented
//   at the resolver layer.
//
// PHI invariant: this module is configuration-only. Overlay rows
// are non-PHI. The resolver never touches patient or order data.

import { buildMergedPolicy, type MergedWorkflowPolicy } from "./policy-overlay.js";
import type { OrderWorkflowPolicy } from "./policy-v1.js";
import type { WorkflowPolicyOverlayBinding } from "./policy-overlay.js";

// ---------------------------------------------------------------------------
// OverlaySource — read port.
// ---------------------------------------------------------------------------

export interface OverlayLoadInput {
  /** Tenant the overlay set is scoped to. RLS is upstream. */
  readonly organizationId: string;
  /**
   * Base policy id stamped on the order. Overlays are bound to a
   * specific (orgId, basePolicyId); a v1 → v2 base activation
   * requires re-authoring overlays against v2 (ADR 0019 §4).
   */
  readonly basePolicyId: string;
  /**
   * Optional clinic scope. When set, the source SHOULD return
   * org-wide bindings (clinicId === undefined) plus clinic-scoped
   * bindings whose `clinicId` matches. The resolver does not
   * filter further; the source is responsible for the
   * tenancy-correct read.
   */
  readonly clinicId?: string;
}

export interface OverlaySource {
  /**
   * Returns the ACTIVE overlay bindings for the given tenant +
   * base policy. The contract:
   *   - Returns ONLY bindings with status=ACTIVE.
   *   - Returns the bindings in any order; the resolver sorts
   *     them by priority before composition.
   *   - Empty array means "no overlays active for this tenant" —
   *     the resolver short-circuits and returns base unchanged.
   */
  load(input: OverlayLoadInput): Promise<ReadonlyArray<WorkflowPolicyOverlayBinding>>;
}

/**
 * In-memory source for tests. Construct with a literal map of
 * bindings keyed by `(organizationId, basePolicyId)` tuples.
 *
 * The map is stored by reference; tests that mutate the bindings
 * after construction will see those changes through the source.
 * Use `setBindings` to do this explicitly (more readable than
 * mutating constructor arguments in place).
 */
export class InMemoryOverlaySource implements OverlaySource {
  private readonly byKey: Map<string, ReadonlyArray<WorkflowPolicyOverlayBinding>>;

  public constructor(
    entries: ReadonlyArray<{
      readonly organizationId: string;
      readonly basePolicyId: string;
      readonly bindings: ReadonlyArray<WorkflowPolicyOverlayBinding>;
    }> = []
  ) {
    this.byKey = new Map();
    for (const entry of entries) {
      this.byKey.set(keyOf(entry.organizationId, entry.basePolicyId), entry.bindings);
    }
  }

  public async load(input: OverlayLoadInput): Promise<ReadonlyArray<WorkflowPolicyOverlayBinding>> {
    return this.byKey.get(keyOf(input.organizationId, input.basePolicyId)) ?? [];
  }

  public setBindings(args: {
    readonly organizationId: string;
    readonly basePolicyId: string;
    readonly bindings: ReadonlyArray<WorkflowPolicyOverlayBinding>;
  }): void {
    this.byKey.set(keyOf(args.organizationId, args.basePolicyId), args.bindings);
  }

  public clear(): void {
    this.byKey.clear();
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Default cache TTL. Picked to be:
 *   - Long enough that steady-state hit rate stays high.
 *   - Short enough that admins describe activation propagation
 *     as "within 30 seconds" without operators waiting.
 */
export const DEFAULT_OVERLAY_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  readonly snapshot: MergedWorkflowPolicy;
  readonly expiresAtMs: number;
}

/**
 * Process-local overlay cache. Keyed by
 * `${organizationId}|${basePolicyId}|${clinicId ?? "*"}`. Each
 * entry holds an IMMUTABLE merged snapshot plus a wall-clock
 * expiration.
 *
 * Concurrency: a Map is enough. The bus is single-threaded
 * within a Node process; concurrent `get` / `set` from different
 * async tasks is safe because both operations are synchronous on
 * the Map.
 *
 * Eviction: LRU is overkill for this workload (per-tenant set is
 * small). We TTL-expire on read and never proactively evict; the
 * Map grows to at most `O(tenants × basePolicies × clinics)`
 * which is tiny. A future bounded-cache wrapper is fine if
 * needed.
 */
export class WorkflowPolicyOverlayCache {
  private readonly entries: Map<string, CacheEntry>;
  private readonly ttlMs: number;
  private readonly nowMs: () => number;

  public constructor(args: { readonly ttlMs?: number; readonly nowMs?: () => number } = {}) {
    this.entries = new Map();
    this.ttlMs = args.ttlMs ?? DEFAULT_OVERLAY_CACHE_TTL_MS;
    this.nowMs = args.nowMs ?? Date.now;
  }

  /** Returns the cached snapshot, or undefined on miss / expired. */
  public get(key: ResolvePolicyForTenantInput): MergedWorkflowPolicy | undefined {
    const k = cacheKeyOf(key);
    const entry = this.entries.get(k);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= this.nowMs()) {
      this.entries.delete(k);
      return undefined;
    }
    return entry.snapshot;
  }

  /** Caches a snapshot. Replaces any existing entry for the key. */
  public set(key: ResolvePolicyForTenantInput, snapshot: MergedWorkflowPolicy): void {
    this.entries.set(cacheKeyOf(key), {
      snapshot,
      expiresAtMs: this.nowMs() + this.ttlMs,
    });
  }

  /**
   * Invalidate every cached snapshot for one tenant. Called from
   * lifecycle commands (`ActivateOverlay`, `DeactivateOverlay`)
   * after the activation transaction commits.
   *
   * If `basePolicyId` is supplied, only entries for THAT base
   * policy are dropped — useful when an overlay activation is
   * scoped to one base version (the common case).
   */
  public invalidate(args: {
    readonly organizationId: string;
    readonly basePolicyId?: string;
  }): void {
    const prefix =
      args.basePolicyId === undefined
        ? `${args.organizationId}|`
        : `${args.organizationId}|${args.basePolicyId}|`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Test-only: drop everything. */
  public clear(): void {
    this.entries.clear();
  }

  /** Diagnostics: number of LIVE entries (does not count expired). */
  public size(): number {
    const now = this.nowMs();
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.expiresAtMs > now) n += 1;
    }
    return n;
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ResolvePolicyForTenantInput {
  readonly organizationId: string;
  readonly basePolicyId: string;
  readonly basePolicyVersion: number;
  readonly basePolicy: OrderWorkflowPolicy;
  readonly clinicId?: string;
}

export interface ResolvePolicyForTenantDeps {
  readonly source: OverlaySource;
  readonly cache: WorkflowPolicyOverlayCache;
}

/**
 * Resolves the `MergedWorkflowPolicy` for one (tenant, base
 * policy, optional clinic) tuple. Cache-then-source: a hit
 * returns the cached snapshot; a miss reads through the source,
 * builds a snapshot, and caches it before returning.
 *
 * Determinism within a tx: the bus calls this ONCE per command
 * inside the bus tx. The returned snapshot is what the rest of
 * the tx (validate prereqs, update status, write events) reads.
 * If a sibling worker activates a new overlay between this call
 * and tx commit, the in-flight tx still uses its captured
 * snapshot — that is the load-bearing in-flight rule from ADR
 * 0019 §3.
 */
export async function resolvePolicyForTenant(
  input: ResolvePolicyForTenantInput,
  deps: ResolvePolicyForTenantDeps
): Promise<MergedWorkflowPolicy> {
  const cached = deps.cache.get(input);
  if (cached !== undefined) return cached;

  const bindings = await deps.source.load({
    organizationId: input.organizationId,
    basePolicyId: input.basePolicyId,
    ...(input.clinicId === undefined ? {} : { clinicId: input.clinicId }),
  });

  const snapshot = buildMergedPolicy({
    basePolicy: input.basePolicy,
    basePolicyId: input.basePolicyId,
    basePolicyVersion: input.basePolicyVersion,
    bindings,
  });

  deps.cache.set(input, snapshot);
  return snapshot;
}

/**
 * Convenience wrapper around `WorkflowPolicyOverlayCache.invalidate`.
 * Lifecycle commands (`ActivatePolicyVersion`, `ActivateOverlay`,
 * `DeactivateOverlay`) call this from inside their `exec` AFTER the
 * activation row is written but BEFORE the tx commits. The bus's
 * post-commit hook is the wrong layer because invalidation is a
 * cache concern; the cache is process-local.
 *
 * Sibling workers see the new state after their own TTL expires —
 * the trade-off documented in this module's header.
 */
export function invalidatePolicyCache(
  cache: WorkflowPolicyOverlayCache,
  args: { readonly organizationId: string; readonly basePolicyId?: string }
): void {
  cache.invalidate(args);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function keyOf(orgId: string, basePolicyId: string): string {
  return `${orgId}|${basePolicyId}`;
}

function cacheKeyOf(input: ResolvePolicyForTenantInput): string {
  return `${input.organizationId}|${input.basePolicyId}|${input.clinicId ?? "*"}`;
}
