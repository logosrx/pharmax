// Operator-identity cache: the Pharmax `user` id → user-row projection.
//
// ADR-0030: sessions resolve to a Pharmax `user.id` directly (no Clerk
// bridge). `resolveOperatorTenancyContext` reads the session, then looks
// up the near-immutable user row (email/displayName/status) — the part
// worth caching across requests. Keyed by `userId` (was `clerkUserId`).
//
// Safety model (the row carries authz-relevant `status`, so staleness is
// bounded deliberately):
//   - SHORT TTL: self-healing safety net for a missed invalidation.
//   - EXPLICIT invalidation on any user mutation that changes status
//     (termination, suspension) — the command's onSuccess hook drops
//     this key so the next request re-resolves.
//   - Never negatively cached: a not-found result is re-resolved every
//     call, so a just-provisioned operator is never locked out.
//
// PHI invariant: the `user` row is operator identity, never patient data.

import "server-only";

import { cacheKey, type Cache } from "@pharmax/composition";

import { getServerCache } from "../cache.js";

export const OPERATOR_IDENTITY_CACHE_TTL_MS = 30_000;

/** The cached projection of the Pharmax `user` row, keyed by user id. */
export interface CachedOperatorRow {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly displayName: string;
  // Stored as the UserStatus string (JSON round-trips enums to strings).
  readonly status: string;
}

/** Namespaced, versioned cache key for one operator identity (by user id). */
export function operatorIdentityCacheKey(userId: string): string {
  // v2: re-keyed from clerkUserId → Pharmax userId (ADR-0030).
  return cacheKey("operator-identity", 2, userId);
}

/**
 * Drop the cached identity row for a user id. Best-effort: a transport
 * error is swallowed because the short TTL is the safety net and a
 * failed invalidation must never break the caller that triggered it.
 */
export async function invalidateOperatorIdentityCache(
  userId: string,
  options: { readonly cache?: Cache } = {}
): Promise<void> {
  const cache = options.cache ?? getServerCache();
  try {
    await cache.delete(operatorIdentityCacheKey(userId));
  } catch {
    // Intentionally swallowed — TTL bounds staleness.
  }
}
