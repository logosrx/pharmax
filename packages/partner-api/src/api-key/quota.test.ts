import { describe, expect, it } from "vitest";

import { ApiKeyQuotaTier } from "@pharmax/database";

import {
  API_KEY_QUOTA_TIER_NAMES,
  API_KEY_QUOTA_TIERS,
  getApiKeyQuota,
  isApiKeyQuotaTier,
} from "./quota.js";

describe("API key quota tiers", () => {
  it("defines a quota for every ApiKeyQuotaTier enum member", () => {
    for (const tier of Object.values(ApiKeyQuotaTier)) {
      const quota = getApiKeyQuota(tier);
      expect(quota.tier).toBe(tier);
      expect(quota.burst.limit).toBeGreaterThan(0);
      expect(quota.burst.windowMs).toBeGreaterThan(0);
      expect(quota.daily.limit).toBeGreaterThan(0);
      expect(quota.daily.windowMs).toBeGreaterThan(0);
    }
  });

  it("keeps STANDARD burst at the pre-tier shared limit (120/min)", () => {
    // Introducing tiers must not change any existing partner's
    // effective ceiling — every pre-tier key backfills to STANDARD.
    expect(API_KEY_QUOTA_TIERS.STANDARD.burst).toEqual({ limit: 120, windowMs: 60_000 });
  });

  it("gives ELEVATED strictly higher ceilings than STANDARD", () => {
    expect(API_KEY_QUOTA_TIERS.ELEVATED.burst.limit).toBeGreaterThan(
      API_KEY_QUOTA_TIERS.STANDARD.burst.limit
    );
    expect(API_KEY_QUOTA_TIERS.ELEVATED.daily.limit).toBeGreaterThan(
      API_KEY_QUOTA_TIERS.STANDARD.daily.limit
    );
  });

  it("caps every daily quota above the burst rate's theoretical daily maximum being exceeded instantly", () => {
    // A daily quota below one burst-window's worth of traffic would
    // make the burst limit unreachable — a misconfigured tier.
    for (const tier of API_KEY_QUOTA_TIER_NAMES) {
      const quota = API_KEY_QUOTA_TIERS[tier];
      expect(quota.daily.limit).toBeGreaterThan(quota.burst.limit);
      expect(quota.daily.windowMs).toBeGreaterThan(quota.burst.windowMs);
    }
  });

  it("isApiKeyQuotaTier narrows tier names and rejects everything else", () => {
    expect(isApiKeyQuotaTier("STANDARD")).toBe(true);
    expect(isApiKeyQuotaTier("ELEVATED")).toBe(true);
    expect(isApiKeyQuotaTier("standard")).toBe(false);
    expect(isApiKeyQuotaTier("")).toBe(false);
    expect(isApiKeyQuotaTier(null)).toBe(false);
    expect(isApiKeyQuotaTier(42)).toBe(false);
  });

  it("freezes the catalog so shared rules cannot be mutated", () => {
    expect(Object.isFrozen(API_KEY_QUOTA_TIERS)).toBe(true);
    expect(Object.isFrozen(API_KEY_QUOTA_TIERS.STANDARD)).toBe(true);
    expect(Object.isFrozen(API_KEY_QUOTA_TIERS.STANDARD.burst)).toBe(true);
  });
});
