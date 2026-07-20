import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashSessionToken, mintSessionToken, MIN_SESSION_TOKEN_BYTES } from "./token.js";

describe("mintSessionToken", () => {
  it("produces a URL-safe base64url token with no padding", () => {
    const token = mintSessionToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");
  });

  it("is unique across calls (no static token)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(mintSessionToken(32));
    expect(seen.size).toBe(100);
  });

  it("clamps byte length UP to the 256-bit floor when asked for less", () => {
    // 8 bytes requested → clamped to 32 bytes → 43 base64url chars.
    const short = mintSessionToken(8);
    // 32 bytes → ceil(32/3)*4 = 44, minus padding → 43 chars.
    expect(short.length).toBe(43);
  });

  it("honors the floor constant", () => {
    expect(MIN_SESSION_TOKEN_BYTES).toBe(32);
  });
});

describe("hashSessionToken", () => {
  it("is a deterministic SHA-256 hex digest", () => {
    const raw = "abc123";
    const expected = createHash("sha256").update(raw, "utf8").digest("hex");
    expect(hashSessionToken(raw)).toBe(expected);
    expect(hashSessionToken(raw)).toBe(hashSessionToken(raw));
  });

  it("differs for different inputs and never returns the raw token", () => {
    const raw = mintSessionToken(32);
    const hash = hashSessionToken(raw);
    expect(hash).not.toBe(raw);
    expect(hash).toHaveLength(64);
    expect(hashSessionToken(raw)).not.toBe(hashSessionToken(`${raw}x`));
  });
});
