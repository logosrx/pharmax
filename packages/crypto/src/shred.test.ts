// Crypto-shred plan tests.
//
// The planning helper is pure and tiny but the rules are
// security-critical:
//   - nextValue is ALWAYS null (the storage caller writes NULL).
//   - Every input field is validated; empty strings or wrong types
//     are rejected before anything is planned.
//   - The reason MUST be in the closed registry — free-form reasons
//     would silently mis-classify the security dashboard.

import { describe, expect, it } from "vitest";

import { CRYPTO_SHRED_REASONS, planCryptoShred } from "./shred.js";

function baseInput() {
  return {
    tenantId: "org-acme",
    table: "patient",
    column: "first_name",
    recordId: "01JZ000000000000000000000P",
    reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN,
  };
}

describe("planCryptoShred — happy paths", () => {
  it("returns nextValue = null", () => {
    const plan = planCryptoShred(baseInput());
    expect(plan.nextValue).toBeNull();
  });

  it("echoes every input field for the audit log", () => {
    const plan = planCryptoShred(baseInput());
    expect(plan).toMatchObject({
      tenantId: "org-acme",
      table: "patient",
      column: "first_name",
      recordId: "01JZ000000000000000000000P",
      reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN,
    });
  });

  it("accepts every registered reason code", () => {
    for (const reason of Object.values(CRYPTO_SHRED_REASONS)) {
      expect(() => planCryptoShred({ ...baseInput(), reason })).not.toThrow();
    }
  });
});

describe("planCryptoShred — validation", () => {
  it("rejects empty tenantId", () => {
    expect(() => planCryptoShred({ ...baseInput(), tenantId: "" })).toThrowError(
      expect.objectContaining({ code: "CRYPTO_VALIDATION" })
    );
  });

  it("rejects empty table", () => {
    expect(() => planCryptoShred({ ...baseInput(), table: "" })).toThrowError(
      expect.objectContaining({ code: "CRYPTO_VALIDATION" })
    );
  });

  it("rejects empty column", () => {
    expect(() => planCryptoShred({ ...baseInput(), column: "" })).toThrowError(
      expect.objectContaining({ code: "CRYPTO_VALIDATION" })
    );
  });

  it("rejects empty recordId", () => {
    expect(() => planCryptoShred({ ...baseInput(), recordId: "" })).toThrowError(
      expect.objectContaining({ code: "CRYPTO_VALIDATION" })
    );
  });

  it("rejects an unregistered reason code", () => {
    expect(() =>
      planCryptoShred({ ...baseInput(), reason: "ad-hoc-reason" as never })
    ).toThrowError(expect.objectContaining({ code: "CRYPTO_VALIDATION" }));
  });
});

describe("CRYPTO_SHRED_REASONS", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(CRYPTO_SHRED_REASONS)).toBe(true);
  });

  it("contains the mandatory codes", () => {
    expect(Object.values(CRYPTO_SHRED_REASONS)).toEqual(
      expect.arrayContaining([
        "right-to-be-forgotten",
        "tenant-offboard",
        "data-retention-expiry",
        "patient-deceased-record-close",
      ])
    );
  });
});
