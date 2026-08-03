import { describe, expect, it } from "vitest";

import { normalizeNdc } from "./normalize-ndc.js";

describe("normalizeNdc", () => {
  it("normalizes dashed 11-digit NDC", () => {
    expect(normalizeNdc("12345-6789-01")).toBe("12345678901");
  });

  it("pads 4-4-2 NDC in the labeler segment (leading zero)", () => {
    expect(normalizeNdc("2345-6789-01")).toBe("02345678901");
  });

  it("pads 5-3-2 NDC in the PRODUCT segment", () => {
    // Regression: the old prepend-only behavior produced
    // 01234567890 for this input — a different (wrong) NDC — so a
    // valid product scan hard-stopped as an NDC mismatch.
    expect(normalizeNdc("12345-678-90")).toBe("12345067890");
  });

  it("pads 5-4-1 NDC in the PACKAGE segment", () => {
    expect(normalizeNdc("12345-6789-0")).toBe("12345678900");
  });

  it("assumes 4-4-2 (prepend) for bare 10-digit values", () => {
    expect(normalizeNdc("2345678901")).toBe("02345678901");
  });

  it("returns null for unrecognized 3-segment shapes", () => {
    expect(normalizeNdc("123456-78-90")).toBeNull();
  });

  it("returns null for invalid lengths", () => {
    expect(normalizeNdc("123")).toBeNull();
    expect(normalizeNdc("")).toBeNull();
  });
});
