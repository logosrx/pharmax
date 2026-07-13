// PasswordHasher — the port the engine depends on.
//
// The concrete Argon2id implementation (`argon2-hasher.ts`) is wired at
// process boot via `configureAuth`, exactly like `@pharmax/crypto`'s
// `KmsAdapter`. Keeping the engine behind a port means:
//
//   - Domain logic (commands, policy) never imports the native argon2
//     binding, so it typechecks and unit-tests without it.
//   - Tests inject a fast fake hasher (no ~100ms KDF per case).
//   - The KDF choice (Argon2id today, could add a rehash-on-login path
//     to a future parameter set) is a boot detail, not scattered through
//     handlers.
//
// A hash string is self-describing (PHC format: `$argon2id$v=19$m=...`),
// so `verify` and `needsRehash` need no external parameters beyond the
// process pepper (bound into the adapter at construction).

export interface PasswordHasher {
  /** Hash a plaintext password. Returns a self-describing PHC string. */
  hash(plaintext: string): Promise<string>;

  /**
   * Constant-time verification of `plaintext` against a stored hash.
   * Returns false on any parse/verify failure — never throws for a
   * simple mismatch (throwing is reserved for a corrupt/foreign hash
   * string, which is a bug, not a wrong password).
   */
  verify(storedHash: string, plaintext: string): Promise<boolean>;

  /**
   * True when `storedHash` was produced with parameters weaker than the
   * current policy (cost increased, algorithm upgraded). The SignIn
   * command calls this after a successful verify and, if true,
   * transparently re-hashes with the current parameters.
   */
  needsRehash(storedHash: string): boolean;
}
