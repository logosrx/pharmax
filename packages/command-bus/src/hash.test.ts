import { describe, expect, it } from "vitest";

import { canonicalStringify, hashRequest } from "./hash.js";

describe("canonicalStringify", () => {
  it("sorts object keys deterministically", () => {
    const a = canonicalStringify({ b: 1, a: 2, c: 3 });
    const b = canonicalStringify({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("recurses into nested objects", () => {
    const a = canonicalStringify({ nested: { z: 1, a: 2 }, top: "x" });
    expect(a).toBe('{"nested":{"a":2,"z":1},"top":"x"}');
  });

  it("preserves array order", () => {
    expect(canonicalStringify({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  it("handles null and undefined", () => {
    expect(canonicalStringify({ a: null, b: undefined })).toBe('{"a":null}');
  });
});

describe("hashRequest", () => {
  it("returns identical hashes for key-reordered identical inputs", () => {
    expect(hashRequest({ b: 1, a: 2 })).toBe(hashRequest({ a: 2, b: 1 }));
  });

  it("returns different hashes for different inputs", () => {
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ b: 1 }));
  });

  it("returns a 64-char lowercase hex string", () => {
    const h = hashRequest({ x: "y" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
