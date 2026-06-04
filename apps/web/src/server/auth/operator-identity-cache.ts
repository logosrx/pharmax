// Operator-identity cache: the Clerk userId → Pharmax `user` row mapping.
//
// This is the canonical first consumer named in the @pharmax/cache design
// notes ("the near-immutable Clerk→Pharmax identity mapping"). Every
// operator request resolves it (see resolve-tenancy.ts), so a cross-request
// cache removes a system-context transaction from the hot path.
//
// Safety model (this row carries the authz-relevant `status`, so staleness
// is bounded deliberately):
//
//   - SHORT TTL (`OPERATOR_IDENTITY_CACHE_TTL_MS`): the self-healing safety
//     net. Worst-case staleness if an invalidation is ever missed.
//   - EXPLICIT invalidation on every Clerk identity mutation
//     (`user.created` / `user.updated` / `user.deleted` — see
//     clerk-webhook-handlers.ts). A terminated operator's cached ACTIVE row
//     is dropped the moment the off-boarding webhook applies.
//   - `cached()` NEVER negatively caches: a not-linked / not-found result is
//     re-resolved from the DB every call, so a just-provisioned operator is
//     never locked out by a cached miss.
//
// PHI invariant: the `user` row is operator identity (email/displayName),
// never patient data.

import "server-only";

import { cacheKey, type Cache } from "@pharmax/composition";

import { getServerCache } from "../cache.js";

/**
 * TTL for the cached operator identity row. Kept short because the row
 * carries authz-relevant `status`; this bounds the worst-case window in
 * which a just-disabled operator could still resolve to ACTIVE if an
 * invalidation were missed. Explicit webhook invalidation is the primary
 * mechanism; this is the safety net.
 */
export const OPERATOR_IDENTITY_CACHE_TTL_MS = 30_000;

/** The cached projection of the Pharmax `user` row keyed by Clerk userId. */
export interface CachedOperatorRow {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly displayName: string;
  // Stored as the UserStatus string (JSON round-trips enums to strings).
  readonly status: string;
  readonly clerkUserId: string | null;
}

/** Namespaced, versioned cache key for one Clerk identity. */
export function operatorIdentityCacheKey(clerkUserId: string): string {
  return cacheKey("operator-identity", 1, clerkUserId);
}

/**
 * Drop the cached identity row for a Clerk userId. Best-effort: a transport
 * error is swallowed because the short TTL is the safety net and a failed
 * invalidation must never break the webhook handler that triggered it.
 *
 * `cache` is injectable for tests; production uses the process singleton.
 */
export async function invalidateOperatorIdentityCache(
  clerkUserId: string,
  options: { readonly cache?: Cache } = {}
): Promise<void> {
  const cache = options.cache ?? getServerCache();
  try {
    await cache.delete(operatorIdentityCacheKey(clerkUserId));
  } catch {
    // Intentionally swallowed — TTL bounds staleness; invalidation is an
    // optimization on top of it.
  }
}
