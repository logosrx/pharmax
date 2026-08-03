import type * as nodeCrypto from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PasswordHasher } from "../password/hasher.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyRecoveryCode,
} from "./recovery-codes.js";

// Declared here rather than imported, so the test pins the alphabet the
// product is supposed to use. Reusing the module's own constant would
// accept a change that reintroduced the ambiguous I/L/O/U/0/1.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

// Lets a test pin the index `randomGroup` draws, so the edges of the
// alphabet can be asserted exactly. Left null for every other test,
// which keeps the real CSPRNG in play.
const scripted = vi.hoisted(() => ({ nextIndex: null as (() => number) | null }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeCrypto>();
  return {
    ...actual,
    randomInt: (max: number): number =>
      scripted.nextIndex === null ? actual.randomInt(max) : scripted.nextIndex(),
  };
});

afterEach(() => {
  scripted.nextIndex = null;
});

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

  it("maps the first and last draw onto the ends of the alphabet", () => {
    // Guards the index range. Drawing over the wrong bound would make
    // one end of the alphabet unreachable (or yield undefined), and a
    // random sample would hide that for a long time.
    scripted.nextIndex = (): number => 0;
    expect(generateRecoveryCodes(1)[0]).toBe("22222-22222");

    scripted.nextIndex = (): number => ALPHABET.length - 1;
    expect(generateRecoveryCodes(1)[0]).toBe("ZZZZZ-ZZZZZ");
  });

  it("draws every alphabet character and nothing outside it", () => {
    const seen = new Set<string>();
    for (const code of generateRecoveryCodes(500)) {
      for (const ch of normalizeRecoveryCode(code)) {
        seen.add(ch);
      }
    }

    // 5000 characters over 30 symbols — missing one would mean the draw
    // cannot reach it, not bad luck.
    expect([...seen].sort().join("")).toBe([...ALPHABET].sort().join(""));
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
