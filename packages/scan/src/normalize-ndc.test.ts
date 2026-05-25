import { describe, expect, it } from "vitest";

import { normalizeNdc } from "./normalize-ndc.js";

describe("normalizeNdc", () => {
  it("normalizes dashed 11-digit NDC", () => {
    expect(normalizeNdc("12345-6789-01")).toBe("12345678901");
  });

  it("pads 10-digit NDC with leading zero", () => {
    expect(normalizeNdc("2345-6789-01")).toBe("02345678901");
  });

  it("returns null for invalid lengths", () => {
    expect(normalizeNdc("123")).toBeNull();
    expect(normalizeNdc("")).toBeNull();
  });
});
