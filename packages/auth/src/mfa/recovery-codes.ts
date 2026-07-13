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
  // Rejection-free mapping: use a byte per char, modulo the alphabet.
  // The tiny modulo bias over a 30-char alphabet is irrelevant for a
  // one-time recovery code whose entropy comes from length, not from
  // perfect uniformity.
  const bytes = randomBytes(GROUP_LEN);
  let out = "";
  for (let i = 0; i < GROUP_LEN; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}
