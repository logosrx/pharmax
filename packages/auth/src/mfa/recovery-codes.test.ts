import { describe, expect, it } from "vitest";

import type { PasswordHasher } from "../password/hasher.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyRecoveryCode,
} from "./recovery-codes.js";

// Fast deterministic fake so recovery-code tests don't pay the Argon2id
// cost — the hashing itself is covered in argon2-hasher.test.ts.
const fakeHasher: PasswordHasher = {
  async hash(plaintext) {
    return `h:${plaintext}`;
  },
  async verify(storedHash, plaintext) {
    return storedHash === `h:${plaintext}`;
  },
  needsRehash() {
    return false;
  },
};

describe("generateRecoveryCodes", () => {
  it("generates the requested count of unambiguous, grouped codes", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    }
    expect(new Set(codes).size).toBe(10);
  });
});

describe("normalizeRecoveryCode", () => {
  it("strips separators/whitespace and uppercases", () => {
    expect(normalizeRecoveryCode("a2c4e-9ghjk")).toBe("A2C4E9GHJK");
    expect(normalizeRecoveryCode("A2C4E 9GHJK")).toBe("A2C4E9GHJK");
  });
});

describe("hashRecoveryCode / verifyRecoveryCode", () => {
  it("verifies a code regardless of separators/case", async () => {
    const [code] = generateRecoveryCodes(1);
    const hash = await hashRecoveryCode(fakeHasher, code!);
    expect(await verifyRecoveryCode(fakeHasher, code!, hash)).toBe(true);
    expect(await verifyRecoveryCode(fakeHasher, code!.toLowerCase(), hash)).toBe(true);
    expect(await verifyRecoveryCode(fakeHasher, code!.replace("-", " "), hash)).toBe(true);
  });

  it("rejects a different code", async () => {
    const [a, b] = generateRecoveryCodes(2);
    const hash = await hashRecoveryCode(fakeHasher, a!);
    expect(await verifyRecoveryCode(fakeHasher, b!, hash)).toBe(false);
  });
});
