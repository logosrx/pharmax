// Blind index tests.
//
// What we pin:
//   - Determinism per (tenant, table, column, value): same inputs
//     always hash to the same blind index. (This is the SELECT
//     guarantee.)
//   - Tenant isolation: two tenants with the same plaintext produce
//     different blind indexes.
//   - Column isolation: same value in different columns produces
//     different indexes.
//   - Normalization: case/accent/whitespace variants collapse.
//   - Phone normalizer strips non-digits and keeps last 10.
//   - Empty normalization → null (caller writes NULL, not "").
//   - Custom normalizer override path works.
//   - Configuration is required.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { blindIndex, normalizeForBlindIndex, normalizePhoneForBlindIndex } from "./blind-index.js";
import { configureCrypto, resetCryptoConfigurationForTests } from "./configure.js";
import { LocalKmsAdapter } from "./local-kms-adapter.js";

beforeEach(() => {
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "blind-index-test-seed" }) });
});

afterEach(() => {
  resetCryptoConfigurationForTests();
});

const PATIENT_FIRST_NAME = {
  tenantId: "org-acme",
  table: "patient",
  column: "first_name",
} as const;

describe("normalizeForBlindIndex", () => {
  it("lowercases", () => {
    expect(normalizeForBlindIndex("Jane")).toBe("jane");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeForBlindIndex("  Jane  ")).toBe("jane");
  });

  it("collapses inner whitespace runs to single space", () => {
    expect(normalizeForBlindIndex("Jane   Q   Doe")).toBe("jane q doe");
  });

  it("strips combining marks (Café == Cafe)", () => {
    expect(normalizeForBlindIndex("Café")).toBe(normalizeForBlindIndex("Cafe"));
    expect(normalizeForBlindIndex("Renée")).toBe(normalizeForBlindIndex("Renee"));
  });

  it("returns empty string for empty / whitespace-only input", () => {
    expect(normalizeForBlindIndex("")).toBe("");
    expect(normalizeForBlindIndex("   ")).toBe("");
  });

  it("rejects non-string input", () => {
    expect(() => normalizeForBlindIndex(42 as unknown as string)).toThrowError(
      expect.objectContaining({ code: "CRYPTO_VALIDATION" })
    );
  });
});

describe("normalizePhoneForBlindIndex", () => {
  it("strips formatting", () => {
    expect(normalizePhoneForBlindIndex("(415) 555-1234")).toBe("4155551234");
  });

  it("keeps the last 10 digits when longer (country code stripped)", () => {
    expect(normalizePhoneForBlindIndex("+1-415-555-1234")).toBe("4155551234");
    expect(normalizePhoneForBlindIndex("011-44-20-7946-0958")).toBe("2079460958");
  });

  it("returns empty for inputs with no digits", () => {
    expect(normalizePhoneForBlindIndex("(no phone)")).toBe("");
    expect(normalizePhoneForBlindIndex("")).toBe("");
  });
});

describe("blindIndex — determinism", () => {
  it("same value + same binding → same hash", async () => {
    const a = await blindIndex({ value: "Jane", binding: PATIENT_FIRST_NAME });
    const b = await blindIndex({ value: "Jane", binding: PATIENT_FIRST_NAME });
    expect(a).toBe(b);
  });

  it("normalized variants collapse to the same hash", async () => {
    const a = await blindIndex({ value: "Jane", binding: PATIENT_FIRST_NAME });
    const b = await blindIndex({ value: "  JANE  ", binding: PATIENT_FIRST_NAME });
    const c = await blindIndex({ value: "Janè", binding: PATIENT_FIRST_NAME });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("returns null when normalization yields empty", async () => {
    const out = await blindIndex({ value: "   ", binding: PATIENT_FIRST_NAME });
    expect(out).toBeNull();
  });

  it("output is base64url with no padding", async () => {
    const out = await blindIndex({ value: "Jane", binding: PATIENT_FIRST_NAME });
    expect(out).not.toBeNull();
    expect(out!).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(out!.includes("=")).toBe(false);
  });
});

describe("blindIndex — isolation", () => {
  it("different tenants → different blind index for the same value", async () => {
    const a = await blindIndex({
      value: "Jane",
      binding: { tenantId: "org-A", table: "patient", column: "first_name" },
    });
    const b = await blindIndex({
      value: "Jane",
      binding: { tenantId: "org-B", table: "patient", column: "first_name" },
    });
    expect(a).not.toBe(b);
  });

  it("different columns → different blind index for the same value", async () => {
    const a = await blindIndex({
      value: "Smith",
      binding: { tenantId: "org-A", table: "patient", column: "first_name" },
    });
    const b = await blindIndex({
      value: "Smith",
      binding: { tenantId: "org-A", table: "patient", column: "last_name" },
    });
    expect(a).not.toBe(b);
  });

  it("different tables → different blind index for the same value", async () => {
    const a = await blindIndex({
      value: "Smith",
      binding: { tenantId: "org-A", table: "patient", column: "first_name" },
    });
    const b = await blindIndex({
      value: "Smith",
      binding: { tenantId: "org-A", table: "provider", column: "first_name" },
    });
    expect(a).not.toBe(b);
  });
});

describe("blindIndex — custom normalizer", () => {
  it("uses the phone normalizer when provided", async () => {
    const a = await blindIndex({
      value: "(415) 555-1234",
      binding: { tenantId: "org-A", table: "patient", column: "phone" },
      normalize: normalizePhoneForBlindIndex,
    });
    const b = await blindIndex({
      value: "+1.415.555.1234",
      binding: { tenantId: "org-A", table: "patient", column: "phone" },
      normalize: normalizePhoneForBlindIndex,
    });
    expect(a).toBe(b);
  });
});

describe("blindIndex — configuration", () => {
  it("throws CRYPTO_NOT_CONFIGURED when crypto was never configured", async () => {
    resetCryptoConfigurationForTests();
    await expect(blindIndex({ value: "Jane", binding: PATIENT_FIRST_NAME })).rejects.toMatchObject({
      code: "CRYPTO_NOT_CONFIGURED",
    });
  });
});
