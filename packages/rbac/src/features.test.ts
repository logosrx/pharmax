// Features registry tests.
//
// The features registry is the parallel universe to permissions:
// capability flags that gate UI affordances and integration
// availability without granting access. The tests here pin the
// invariants that make the split meaningful:
//
//   - The registry is frozen and the metadata is total (no orphans).
//   - Defaults are sane (workflow ON, hardware/integration OFF).
//   - The type guard is closed against unknown strings.
//
// Parity against a future `feature_flag` seed table will be added
// when that table lands in Phase 2. For now, the registry alone is
// the single source of truth.

import { describe, expect, it } from "vitest";

import { ALL_FEATURE_CODES, FEATURE_METADATA, FEATURES, isFeatureCode } from "./features.js";

describe("FEATURES registry", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(FEATURES)).toBe(true);
  });

  it("has unique codes", () => {
    const set = new Set(ALL_FEATURE_CODES);
    expect(set.size).toBe(ALL_FEATURE_CODES.length);
  });

  it("uses dotted kebab-case (distinct from permission codes)", () => {
    for (const code of ALL_FEATURE_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]+$/);
    }
  });
});

describe("FEATURE_METADATA", () => {
  it("has an entry for every code", () => {
    for (const code of ALL_FEATURE_CODES) {
      const meta = FEATURE_METADATA[code];
      expect(meta).toBeDefined();
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.category.length).toBeGreaterThan(0);
      expect(typeof meta.defaultEnabled).toBe("boolean");
    }
  });

  it("has no orphan entries", () => {
    const codes = new Set<string>(ALL_FEATURE_CODES);
    for (const k of Object.keys(FEATURE_METADATA)) {
      expect(codes.has(k)).toBe(true);
    }
  });

  it("workflow features default ON (they are core product)", () => {
    expect(FEATURE_METADATA[FEATURES.CUSTOM_BUCKETS].defaultEnabled).toBe(true);
    expect(FEATURE_METADATA[FEATURES.EMERGENCY_BUCKETS].defaultEnabled).toBe(true);
    expect(FEATURE_METADATA[FEATURES.REOPEN_FOR_CORRECTION].defaultEnabled).toBe(true);
  });

  it("hardware features default OFF (require paired workstation)", () => {
    expect(FEATURE_METADATA[FEATURES.ZEBRA_LABEL_PRINT].defaultEnabled).toBe(false);
    expect(FEATURE_METADATA[FEATURES.BARCODE_SCAN_VALIDATION].defaultEnabled).toBe(false);
    expect(FEATURE_METADATA[FEATURES.WORKSTATION_BINDING].defaultEnabled).toBe(false);
  });

  it("integration features default OFF (require configured credentials)", () => {
    expect(FEATURE_METADATA[FEATURES.EASYPOST_OUTBOUND].defaultEnabled).toBe(false);
    expect(FEATURE_METADATA[FEATURES.LIFEFILE_INBOUND].defaultEnabled).toBe(false);
    expect(FEATURE_METADATA[FEATURES.STRIPE_BILLING].defaultEnabled).toBe(false);
  });
});

describe("isFeatureCode", () => {
  it("returns true for every registered code", () => {
    for (const code of ALL_FEATURE_CODES) {
      expect(isFeatureCode(code)).toBe(true);
    }
  });

  it("returns false for unknown strings, undefined, and non-strings", () => {
    expect(isFeatureCode("hardware.zebra")).toBe(false);
    expect(isFeatureCode("")).toBe(false);
    expect(isFeatureCode(undefined)).toBe(false);
    expect(isFeatureCode(42)).toBe(false);
    expect(isFeatureCode({ code: "shipping.easypost-outbound" })).toBe(false);
  });
});
