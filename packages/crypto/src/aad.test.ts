// AAD canonical encoding tests.
//
// The AAD layer is the linchpin of the "no moving ciphertexts
// between rows" guarantee. We pin:
//
//   - Determinism: same binding → same bytes, every time.
//   - Field-order independence: callers can build bindings in any
//     order (object literal vs spread vs computed key) and the
//     output is the same.
//   - Distinct outputs for every single-field difference.
//   - Validation: empty fields and NUL bytes are rejected loudly.
//   - The version prefix is the same we ship today (a future-self
//     refactor that bumps it is a deliberate SOC 2 event, not an
//     accidental drift).

import { describe, expect, it } from "vitest";

import { AAD_VERSION, bindingsEqual, encodeAad, type RecordBinding } from "./aad.js";

function binding(overrides: Partial<RecordBinding> = {}): RecordBinding {
  return {
    tenantId: "org-acme",
    table: "patient",
    column: "first_name",
    recordId: "01JZ000000000000000000000P",
    ...overrides,
  };
}

describe("AAD_VERSION", () => {
  it("is the pinned v1 string (changing this is a SOC 2 event)", () => {
    expect(AAD_VERSION).toBe("crypto.v1");
  });
});

describe("encodeAad — determinism", () => {
  it("same binding produces identical bytes across calls", () => {
    const a = encodeAad(binding());
    const b = encodeAad(binding());
    expect(a.equals(b)).toBe(true);
  });

  it("field order at construction time does not matter", () => {
    const a = encodeAad({
      tenantId: "T",
      table: "patient",
      column: "first_name",
      recordId: "R",
    });
    const b = encodeAad({
      recordId: "R",
      column: "first_name",
      table: "patient",
      tenantId: "T",
    });
    expect(a.equals(b)).toBe(true);
  });

  it("embeds the version prefix at the start of the bytes", () => {
    const bytes = encodeAad(binding());
    const head = bytes.subarray(0, AAD_VERSION.length).toString("utf8");
    expect(head).toBe(AAD_VERSION);
  });
});

describe("encodeAad — discrimination", () => {
  it("changing tenantId produces different bytes", () => {
    expect(encodeAad(binding()).equals(encodeAad(binding({ tenantId: "org-other" })))).toBe(false);
  });

  it("changing table produces different bytes", () => {
    expect(encodeAad(binding()).equals(encodeAad(binding({ table: "prescription" })))).toBe(false);
  });

  it("changing column produces different bytes", () => {
    expect(encodeAad(binding()).equals(encodeAad(binding({ column: "last_name" })))).toBe(false);
  });

  it("changing recordId produces different bytes", () => {
    expect(encodeAad(binding()).equals(encodeAad(binding({ recordId: "01JZ999..." })))).toBe(false);
  });
});

describe("bindingsEqual", () => {
  it("returns true for the same binding constructed two ways", () => {
    expect(bindingsEqual(binding(), { ...binding() })).toBe(true);
  });

  it("returns false for any single-field difference", () => {
    expect(bindingsEqual(binding(), binding({ recordId: "other" }))).toBe(false);
  });
});

describe("encodeAad — validation", () => {
  it("rejects empty fields", () => {
    expect(() => encodeAad(binding({ tenantId: "" }))).toThrowError(
      expect.objectContaining({ code: "CRYPTO_VALIDATION" })
    );
    expect(() => encodeAad(binding({ table: "" }))).toThrowError(
      expect.objectContaining({ code: "CRYPTO_VALIDATION" })
    );
  });

  it("rejects NUL in any field", () => {
    expect(() => encodeAad(binding({ tenantId: "org\x00evil" }))).toThrowError(
      expect.objectContaining({ code: "CRYPTO_VALIDATION" })
    );
  });

  it("rejects non-string fields (defensive against runtime junk)", () => {
    expect(() => encodeAad(binding({ tenantId: 123 as unknown as string }))).toThrowError(
      expect.objectContaining({ code: "CRYPTO_VALIDATION" })
    );
  });
});
