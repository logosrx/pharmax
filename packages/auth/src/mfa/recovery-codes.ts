// MFA recovery codes.
//
// Single-use fallback when the authenticator is unavailable. Generated
// at enrollment, shown to the user ONCE, and stored only as Argon2id
// hashes (reusing the configured `PasswordHasher`). Verification is a
// constant-time hash compare; the command layer stamps `usedAt` so a
// code is never redeemable twice.

import { randomBytes } from "node:crypto";

import type { PasswordHasher } from "../password/hasher.js";

// Crockford-ish alphabet: unambiguous (no I, L, O, U, 0, 1).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP_LEN = 5;
const GROUPS = 2; // e.g. "A2C4E-9GHJK"

// A byte holds 256 values but the alphabet has 30 characters, so the
// range does not divide evenly. These two constants carve out the part
// that does: BYTES_PER_CHAR (8) byte values map to each character, and
// any byte at or above UNBIASED_BYTE_LIMIT (240) is discarded.
const BYTES_PER_CHAR = Math.floor(256 / ALPHABET.length);
const UNBIASED_BYTE_LIMIT = BYTES_PER_CHAR * ALPHABET.length;

/** Generate `count` display codes like "A2C4E-9GHJK". */
export function generateRecoveryCodes(count: number): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const groups: string[] = [];
    for (let g = 0; g < GROUPS; g += 1) {
      groups.push(randomGroup());
    }
    codes.push(groups.join("-"));
  }
  return codes;
}

/**
 * Normalize a code for hashing/verification: strip separators and
 * whitespace, uppercase. So "a2c4e-9ghjk" and "A2C4E 9GHJK" both match.
 */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]+/g, "").toUpperCase();
}

/** Hash a recovery code with the configured (Argon2id) hasher. */
export async function hashRecoveryCode(hasher: PasswordHasher, code: string): Promise<string> {
  return hasher.hash(normalizeRecoveryCode(code));
}

/** Constant-time verify a submitted code against a stored hash. */
export async function verifyRecoveryCode(
  hasher: PasswordHasher,
  submitted: string,
  storedHash: string
): Promise<boolean> {
  return hasher.verify(storedHash, normalizeRecoveryCode(submitted));
}

function randomGroup(): string {
  // Rejection sampling, so every character is exactly equally likely.
  // Folding a whole byte into the alphabet with `% 30` would make the
  // first 16 characters ~17% more likely than the last 14; integer
  // division of an accepted byte cannot skew the distribution.
  let out = "";
  while (out.length < GROUP_LEN) {
    // Draw a group's worth of bytes at a time — rejections are rare
    // (16 of 256 values), so this almost always needs one draw.
    for (const byte of randomBytes(GROUP_LEN)) {
      if (byte >= UNBIASED_BYTE_LIMIT) {
        continue;
      }
      out += ALPHABET[Math.floor(byte / BYTES_PER_CHAR)]!;
      if (out.length === GROUP_LEN) {
        break;
      }
    }
  }
  return out;
}
