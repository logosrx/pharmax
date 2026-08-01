// Per-key quota tiers for the public v1 API (ADR-0032).
//
// The `api_key` row records WHICH named tier a key belongs to; this
// module owns WHAT each tier means, so the numbers can change in one
// place without a migration. Every tier carries two independent
// ceilings, enforced as two limiter windows on the partner request
// path (`resolvePartnerContext`):
//
//   burst — a rolling per-minute rate that shapes traffic spikes.
//           Exceeding it is a transient condition: back off for the
//           `Retry-After` seconds and continue (HTTP 429
//           RATE_LIMITED).
//   daily — a sustained 24h quota that caps total consumption.
//           Exceeding it means the integration is over its tier and
//           should upgrade or wait for the window to reset (HTTP 429
//           QUOTA_EXCEEDED).
//
// STANDARD's burst numbers are exactly the shared per-key limit that
// predated tiers (120/min), so introducing tiers changed no existing
// partner's effective ceiling.
//
// PHI: none.

import { ApiKeyQuotaTier } from "@pharmax/database";

/** Structurally matches `RateLimitRule` from the limiter port. */
export interface ApiKeyQuotaRule {
  readonly limit: number;
  readonly windowMs: number;
}

export interface ApiKeyQuota {
  readonly tier: ApiKeyQuotaTier;
  readonly burst: ApiKeyQuotaRule;
  readonly daily: ApiKeyQuotaRule;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The tier catalog. Frozen so a caller can never mutate a rule that
 * every request on the instance shares.
 */
export const API_KEY_QUOTA_TIERS: Readonly<Record<ApiKeyQuotaTier, ApiKeyQuota>> = Object.freeze({
  STANDARD: Object.freeze({
    tier: ApiKeyQuotaTier.STANDARD,
    burst: Object.freeze({ limit: 120, windowMs: MINUTE_MS }),
    daily: Object.freeze({ limit: 50_000, windowMs: DAY_MS }),
  }),
  ELEVATED: Object.freeze({
    tier: ApiKeyQuotaTier.ELEVATED,
    burst: Object.freeze({ limit: 600, windowMs: MINUTE_MS }),
    daily: Object.freeze({ limit: 250_000, windowMs: DAY_MS }),
  }),
});

export const API_KEY_QUOTA_TIER_NAMES = Object.freeze(
  Object.keys(API_KEY_QUOTA_TIERS)
) as ReadonlyArray<ApiKeyQuotaTier>;

export function isApiKeyQuotaTier(value: unknown): value is ApiKeyQuotaTier {
  return typeof value === "string" && value in API_KEY_QUOTA_TIERS;
}

export function getApiKeyQuota(tier: ApiKeyQuotaTier): ApiKeyQuota {
  switch (tier) {
    case ApiKeyQuotaTier.STANDARD:
      return API_KEY_QUOTA_TIERS.STANDARD;
    case ApiKeyQuotaTier.ELEVATED:
      return API_KEY_QUOTA_TIERS.ELEVATED;
    default: {
      const exhaustive: never = tier;
      throw new Error(`Unknown API key quota tier: ${String(exhaustive)}`);
    }
  }
}
