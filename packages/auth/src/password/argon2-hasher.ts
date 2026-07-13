// Argon2id password hasher — the production `PasswordHasher`.
//
// Argon2id is the OWASP first-choice password KDF. Parameters default
// to the OWASP baseline (m=19 MiB, t=2, p=1); raise them as hardware
// allows — `needsRehash` then transparently upgrades stored hashes on
// the next successful sign-in.
//
// The PEPPER (a process-wide secret, unwrapped from KMS at boot) is
// passed as Argon2's `secret` input. Unlike the per-hash salt (stored
// in the PHC string), the pepper is NOT stored alongside the hash — so
// a database-only compromise cannot verify or crack passwords without
// also compromising the KMS-held pepper. This is defense-in-depth for
// HIPAA §164.312(a)(2)(iv) / SOC 2 CC6.1.
//
// This module is the ONLY place that imports the native argon2 binding.
// It is wired at boot (apps/web, apps/worker, seed) via `configureAuth`;
// the rest of the engine depends on the `PasswordHasher` port.

import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

import type { PasswordHasher } from "./hasher.js";

export interface Argon2idParams {
  /** Memory cost in KiB. OWASP minimum for Argon2id: 19456 (19 MiB). */
  readonly memoryCost: number;
  /** Iterations (time cost). OWASP minimum: 2. */
  readonly timeCost: number;
  /** Degree of parallelism. OWASP minimum: 1. */
  readonly parallelism: number;
}

/** OWASP Password Storage Cheat Sheet baseline for Argon2id. */
export const DEFAULT_ARGON2ID_PARAMS: Argon2idParams = Object.freeze({
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

export function createArgon2idHasher(opts: {
  readonly params?: Argon2idParams;
  /** KMS-unwrapped pepper. Null/empty disables the pepper (dev only). */
  readonly pepper?: Uint8Array | null;
}): PasswordHasher {
  const params = opts.params ?? DEFAULT_ARGON2ID_PARAMS;
  const secret =
    opts.pepper !== undefined && opts.pepper !== null && opts.pepper.length > 0
      ? Buffer.from(opts.pepper)
      : undefined;

  // `@node-rs/argon2` defaults `algorithm` to Argon2id — the only
  // variant we accept. We do NOT import the `Algorithm` const enum
  // (ambient const enums are incompatible with `verbatimModuleSyntax`);
  // instead `needsRehash` asserts the `$argon2id$` prefix on every
  // stored hash, so a non-Argon2id hash can never silently persist.
  const hashOptions = {
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
    ...(secret === undefined ? {} : { secret }),
  } as const;

  // `verify` only needs the pepper; the salt + params are read from the
  // self-describing PHC hash string.
  const verifyOptions = secret === undefined ? undefined : { secret };

  return {
    async hash(plaintext: string): Promise<string> {
      return argon2Hash(plaintext, hashOptions);
    },

    async verify(storedHash: string, plaintext: string): Promise<boolean> {
      try {
        return await argon2Verify(storedHash, plaintext, verifyOptions);
      } catch {
        // A wrong password returns false from the binding; a throw here
        // means a malformed/foreign hash string. Either way the safe
        // answer to "does this password match?" is no.
        return false;
      }
    },

    needsRehash(storedHash: string): boolean {
      if (!storedHash.startsWith("$argon2id$")) return true;
      const parsed = parsePhcParams(storedHash);
      if (parsed === null) return true;
      return (
        parsed.m < params.memoryCost || parsed.t < params.timeCost || parsed.p < params.parallelism
      );
    },
  };
}

/**
 * Parse the `m=..,t=..,p=..` cost segment of a PHC-format Argon2 hash
 * (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`). Returns null if the
 * segment is missing or malformed — the caller treats that as "rehash".
 */
function parsePhcParams(
  phc: string
): { readonly m: number; readonly t: number; readonly p: number } | null {
  const match = /\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc);
  if (match === null) return null;
  const m = Number(match[1]);
  const t = Number(match[2]);
  const p = Number(match[3]);
  if (!Number.isFinite(m) || !Number.isFinite(t) || !Number.isFinite(p)) return null;
  return { m, t, p };
}
