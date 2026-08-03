import type * as nodeCrypto from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PasswordHasher } from "../password/hasher.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyRecoveryCode,
} from "./recovery-codes.js";

// Lets a single test script the exact bytes `randomGroup` draws, so the
// rejection-sampling branch is covered deterministically. Left null for
// every other test, which keeps the real CSPRNG in play.
const scripted = vi.hoisted(() => ({ nextBytes: null as ((size: number) => Buffer) | null }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeCrypto>();
  return {
    ...actual,
    randomBytes: (size: number): Buffer =>
      scripted.nextBytes === null ? actual.randomBytes(size) : scripted.nextBytes(size),
  };
});

/** Replay `draws` in order, repeating the last entry once exhausted. */
function scriptDraws(draws: ReadonlyArray<ReadonlyArray<number>>): void {
  let call = 0;
  scripted.nextBytes = (): Buffer => {
    const draw = draws[Math.min(call, draws.length - 1)]!;
    call += 1;
    return Buffer.from(draw);
  };
}

afterEach(() => {
  scripted.nextBytes = null;
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

  it("discards the byte values that would bias the alphabet", () => {
    // 240-255 are the 16 values that don't fit a whole 30-character
    // cycle. Folding them in with `% 30` is what made the first 16
    // characters over-represented; they must be drawn again instead.
    // Accepted bytes map by integer division: 0 -> "2", 8 -> "3", etc.
    scriptDraws([
      [240, 241, 247, 250, 255],
      [0, 8, 16, 24, 32],
    ]);

    const [code] = generateRecoveryCodes(1);

    // Both groups consume the second draw; the first is fully rejected.
    expect(code).toBe("23456-23456");
  });

  it("maps the highest accepted byte to the last alphabet character", () => {
    scriptDraws([[239, 239, 239, 239, 239]]);

    const [code] = generateRecoveryCodes(1);

    expect(code).toBe("ZZZZZ-ZZZZZ");
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
