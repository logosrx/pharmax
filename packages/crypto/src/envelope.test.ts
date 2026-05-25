// Envelope parsing / serialization tests.
//
// The envelope parser is the choke point that prevents malformed
// JSON from reaching the AES path. We assert:
//
//   - Round-trip: serialize → parse returns equal shape.
//   - Every required field is checked individually.
//   - Wrong version is rejected (not silently coerced).
//   - Wrong alg is rejected.
//   - Non-object / array / null inputs are rejected.
//   - The type guard mirrors the parser without throwing.

import { describe, expect, it } from "vitest";

import {
  type CiphertextEnvelope,
  ENVELOPE_VERSION,
  isEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from "./envelope.js";

function envelope(overrides: Partial<CiphertextEnvelope> = {}): CiphertextEnvelope {
  return {
    v: ENVELOPE_VERSION,
    alg: "AES-256-GCM",
    kek: "kek:org-acme:v1",
    wDek: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    iv: "AAAAAAAAAAAAAAAA",
    ct: "ZXhhbXBsZQ",
    tag: "AAAAAAAAAAAAAAAAAAAAAA",
    ...overrides,
  };
}

describe("ENVELOPE_VERSION", () => {
  it("is the pinned v1 constant", () => {
    expect(ENVELOPE_VERSION).toBe(1);
  });
});

describe("serializeEnvelope / parseEnvelope round-trip", () => {
  it("preserves every field", () => {
    const original = envelope();
    const wire = serializeEnvelope(original);
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(wire)));
    expect(parsed).toEqual(original);
  });

  it("returns a frozen wire object (no accidental mutation)", () => {
    const wire = serializeEnvelope(envelope());
    expect(Object.isFrozen(wire)).toBe(true);
  });
});

describe("parseEnvelope — rejections", () => {
  it("rejects null", () => {
    expect(() => parseEnvelope(null)).toThrowError(
      expect.objectContaining({ code: "ENVELOPE_MALFORMED" })
    );
  });

  it("rejects arrays", () => {
    expect(() => parseEnvelope([1, 2, 3])).toThrowError(
      expect.objectContaining({ code: "ENVELOPE_MALFORMED" })
    );
  });

  it("rejects primitives", () => {
    expect(() => parseEnvelope("not-an-envelope")).toThrowError(
      expect.objectContaining({ code: "ENVELOPE_MALFORMED" })
    );
    expect(() => parseEnvelope(42)).toThrowError(
      expect.objectContaining({ code: "ENVELOPE_MALFORMED" })
    );
  });

  it("rejects wrong version", () => {
    const wire = { ...serializeEnvelope(envelope()), v: 99 };
    expect(() => parseEnvelope(wire)).toThrowError(
      expect.objectContaining({ code: "ENVELOPE_MALFORMED" })
    );
  });

  it("rejects wrong alg", () => {
    const wire = { ...serializeEnvelope(envelope()), alg: "AES-128-CBC" };
    expect(() => parseEnvelope(wire)).toThrowError(
      expect.objectContaining({ code: "ENVELOPE_MALFORMED" })
    );
  });

  it("rejects missing required fields", () => {
    for (const field of ["kek", "wDek", "iv", "ct", "tag"] as const) {
      const wire: Record<string, unknown> = { ...serializeEnvelope(envelope()) };
      delete wire[field];
      expect(() => parseEnvelope(wire)).toThrowError(
        expect.objectContaining({ code: "ENVELOPE_MALFORMED" })
      );
    }
  });

  it("rejects empty string fields", () => {
    const wire = { ...serializeEnvelope(envelope()), iv: "" };
    expect(() => parseEnvelope(wire)).toThrowError(
      expect.objectContaining({ code: "ENVELOPE_MALFORMED" })
    );
  });
});

describe("isEnvelope", () => {
  it("returns true for a valid envelope", () => {
    expect(isEnvelope(serializeEnvelope(envelope()))).toBe(true);
  });

  it("returns false for malformed input WITHOUT throwing", () => {
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope({})).toBe(false);
    expect(isEnvelope({ v: 2 })).toBe(false);
  });
});
