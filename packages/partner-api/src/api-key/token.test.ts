import { describe, expect, it } from "vitest";

import {
  API_KEY_TOKEN_PREFIX,
  WEBHOOK_SECRET_PREFIX,
  generateApiKeyToken,
  generateWebhookSecret,
  hashApiKeyToken,
  isWellFormedApiKeyToken,
} from "./token.js";

describe("generateApiKeyToken", () => {
  it("produces a pxk_-prefixed, 47-char, well-formed token", () => {
    const generated = generateApiKeyToken();
    expect(generated.token.startsWith(API_KEY_TOKEN_PREFIX)).toBe(true);
    expect(generated.token).toHaveLength(47);
    expect(isWellFormedApiKeyToken(generated.token)).toBe(true);
  });

  it("hash is the SHA-256 hex of the token and the prefix is display-safe", () => {
    const generated = generateApiKeyToken();
    expect(generated.tokenHash).toBe(hashApiKeyToken(generated.token));
    expect(generated.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // Prefix must be short enough to be useless as a credential.
    expect(generated.tokenPrefix).toBe(generated.token.slice(0, 8));
  });

  it("never repeats (entropy smoke check)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      seen.add(generateApiKeyToken().token);
    }
    expect(seen.size).toBe(100);
  });
});

describe("hashApiKeyToken", () => {
  it("is deterministic", () => {
    const token = generateApiKeyToken().token;
    expect(hashApiKeyToken(token)).toBe(hashApiKeyToken(token));
  });

  it("differs for different tokens", () => {
    expect(hashApiKeyToken(generateApiKeyToken().token)).not.toBe(
      hashApiKeyToken(generateApiKeyToken().token)
    );
  });
});

describe("isWellFormedApiKeyToken", () => {
  it("rejects non-strings, wrong prefixes, wrong lengths, bad alphabets", () => {
    expect(isWellFormedApiKeyToken(undefined)).toBe(false);
    expect(isWellFormedApiKeyToken(null)).toBe(false);
    expect(isWellFormedApiKeyToken(42)).toBe(false);
    expect(isWellFormedApiKeyToken("")).toBe(false);
    expect(isWellFormedApiKeyToken("pxk_short")).toBe(false);
    expect(isWellFormedApiKeyToken(`pxw_${"a".repeat(43)}`)).toBe(false);
    expect(isWellFormedApiKeyToken(`pxk_${"a".repeat(42)}!`)).toBe(false);
    expect(isWellFormedApiKeyToken(`pxk_${"a".repeat(44)}`)).toBe(false);
  });

  it("accepts a generated token", () => {
    expect(isWellFormedApiKeyToken(generateApiKeyToken().token)).toBe(true);
  });
});

describe("generateWebhookSecret", () => {
  it("produces a pxw_-prefixed 47-char secret", () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(secret).toHaveLength(47);
    // Must NOT pass as an API key — different credential class.
    expect(isWellFormedApiKeyToken(secret)).toBe(false);
  });
});
