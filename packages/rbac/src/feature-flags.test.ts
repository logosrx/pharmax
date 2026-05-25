// Feature flag resolver tests.
//
// What we pin:
//   - Tenants with no explicit flags get the metadata defaults.
//   - Explicitly TRUE overrides a FALSE default.
//   - Explicitly FALSE overrides a TRUE default.
//   - The cache is keyed on the frozen TenancyContext object — same
//     object hits the cache; a different one does not.
//   - clearFeatureCacheForTests forces a re-load.

import { describe, expect, it, vi } from "vitest";

import { buildTenancyContext } from "@pharmax/tenancy";

import {
  InMemoryFeatureFlagSource,
  clearFeatureCacheForTests,
  resolveEffectiveFeatures,
  type FeatureFlagSource,
} from "./feature-flags.js";
import { FEATURE_METADATA, FEATURES, type FeatureCode } from "./features.js";

function ctxFor(organizationId = "org-1") {
  return buildTenancyContext({
    organizationId,
    actor: { userId: "user-1", correlationId: "01ULID000000000000000000000" },
  });
}

describe("resolveEffectiveFeatures — defaults", () => {
  it("returns metadata defaults for a tenant with no explicit rows", async () => {
    const src = new InMemoryFeatureFlagSource([]);
    const ctx = ctxFor();
    const map = await resolveEffectiveFeatures(ctx, src);

    expect(map.get(FEATURES.CUSTOM_BUCKETS)).toBe(true);
    expect(map.get(FEATURES.EMERGENCY_BUCKETS)).toBe(true);
    expect(map.get(FEATURES.ZEBRA_LABEL_PRINT)).toBe(false);
    expect(map.get(FEATURES.EASYPOST_OUTBOUND)).toBe(false);
    expect(map.get(FEATURES.STRIPE_BILLING)).toBe(false);
  });

  it("returns a value for EVERY registered feature code", async () => {
    const src = new InMemoryFeatureFlagSource([]);
    const ctx = ctxFor();
    const map = await resolveEffectiveFeatures(ctx, src);

    for (const code of Object.keys(FEATURE_METADATA) as ReadonlyArray<FeatureCode>) {
      expect(map.has(code)).toBe(true);
    }
  });
});

describe("resolveEffectiveFeatures — explicit overrides", () => {
  it("explicit TRUE overrides a default-OFF feature", async () => {
    const flags = new Map<FeatureCode, boolean>([[FEATURES.EASYPOST_OUTBOUND, true]]);
    const src = new InMemoryFeatureFlagSource([{ organizationId: "org-1", flags }]);
    const map = await resolveEffectiveFeatures(ctxFor(), src);
    expect(map.get(FEATURES.EASYPOST_OUTBOUND)).toBe(true);
  });

  it("explicit FALSE overrides a default-ON feature", async () => {
    const flags = new Map<FeatureCode, boolean>([[FEATURES.CUSTOM_BUCKETS, false]]);
    const src = new InMemoryFeatureFlagSource([{ organizationId: "org-1", flags }]);
    const map = await resolveEffectiveFeatures(ctxFor(), src);
    expect(map.get(FEATURES.CUSTOM_BUCKETS)).toBe(false);
  });

  it("a tenant's flags do NOT bleed into another tenant", async () => {
    const flagsA = new Map<FeatureCode, boolean>([[FEATURES.EASYPOST_OUTBOUND, true]]);
    const src = new InMemoryFeatureFlagSource([{ organizationId: "org-A", flags: flagsA }]);
    const mapA = await resolveEffectiveFeatures(ctxFor("org-A"), src);
    const mapB = await resolveEffectiveFeatures(ctxFor("org-B"), src);
    expect(mapA.get(FEATURES.EASYPOST_OUTBOUND)).toBe(true);
    expect(mapB.get(FEATURES.EASYPOST_OUTBOUND)).toBe(false);
  });

  it("accepts a plain record (not just a Map) for ergonomics", async () => {
    const src = new InMemoryFeatureFlagSource([
      { organizationId: "org-1", flags: { [FEATURES.ZEBRA_LABEL_PRINT]: true } },
    ]);
    const map = await resolveEffectiveFeatures(ctxFor(), src);
    expect(map.get(FEATURES.ZEBRA_LABEL_PRINT)).toBe(true);
  });

  it("ignores unknown codes in the record-style constructor", async () => {
    const src = new InMemoryFeatureFlagSource([
      {
        organizationId: "org-1",
        flags: { ["definitely.not-real"]: true, [FEATURES.ZEBRA_LABEL_PRINT]: true },
      },
    ]);
    const map = await resolveEffectiveFeatures(ctxFor(), src);
    expect(map.get(FEATURES.ZEBRA_LABEL_PRINT)).toBe(true);
    expect((map as ReadonlyMap<string, boolean>).get("definitely.not-real")).toBeUndefined();
  });
});

describe("resolveEffectiveFeatures — per-context caching", () => {
  it("calls the source ONCE for repeated resolves on the same context", async () => {
    const src: FeatureFlagSource = {
      load: vi.fn(async () => new Map()),
    };
    const ctx = ctxFor();
    await resolveEffectiveFeatures(ctx, src);
    await resolveEffectiveFeatures(ctx, src);
    await resolveEffectiveFeatures(ctx, src);
    expect(src.load).toHaveBeenCalledTimes(1);
  });

  it("calls the source AGAIN for a freshly-built context", async () => {
    const src: FeatureFlagSource = {
      load: vi.fn(async () => new Map()),
    };
    await resolveEffectiveFeatures(ctxFor(), src);
    await resolveEffectiveFeatures(ctxFor(), src);
    expect(src.load).toHaveBeenCalledTimes(2);
  });

  it("clearFeatureCacheForTests forces a re-load on the same context", async () => {
    const src: FeatureFlagSource = {
      load: vi.fn(async () => new Map()),
    };
    const ctx = ctxFor();
    await resolveEffectiveFeatures(ctx, src);
    clearFeatureCacheForTests(ctx);
    await resolveEffectiveFeatures(ctx, src);
    expect(src.load).toHaveBeenCalledTimes(2);
  });
});
