# 0005 — Envelope encryption per PHI field with AAD binding

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** security, phi, encryption

## Context

Pharmax stores PHI (patient names, DOB, sex at birth, SSN-last-4,
phone, email, address, MRN, prescription sig, etc.). HIPAA Safe
Harbor and the project's security rules require strong at-rest
protection, tenant-scoped key isolation, support for the **right to
be forgotten** (crypto-shred), and protection against the "ciphertext
copy" attack where an attacker with DB read+write moves a ciphertext
between rows to learn the plaintext.

Available strategies: **TDE** (protects against disk theft only —
the application has the key, so a SQL injection decrypts everything),
**whole-row encryption** (loses queryability on every column),
**application-layer envelope encryption** per field with per-tenant
KEK, per-record DEK, and AAD binding each ciphertext to its
row/column/tenant.

We also need this primitive **before any PHI table exists** so the
schema can be designed around it (encrypted columns named `*Enc`,
blind-index columns named `*Bi` — see ADR 0010).

## Decision

Implement **envelope encryption per PHI field** in `@pharmax/crypto`,
landed before any PHI table.

- A **per-tenant KEK** is held by a `KmsAdapter` (AWS KMS in
  production; `LocalKmsAdapter` for dev, fatal in production).
- Each field write generates a fresh **per-record DEK**, encrypts
  the plaintext with AES-256-GCM, wraps the DEK with the KEK (also
  AES-256-GCM), and stores the JSON envelope
  `{v, alg, kek, wDek, iv, ct, tag}` in a Prisma `Json` column. DEK
  plaintext is zeroed after use; re-encrypting the same plaintext
  produces a different envelope so storage does not leak repetition.
- **AAD binding** is the load-bearing security primitive. The AAD is a
  canonical, versioned, NUL-separated, sorted-key encoding
  (`crypto.v1`) over `{tenantId, table, column, recordId}`. Every
  binding field demonstrably influences the AAD: a ciphertext moved
  between rows (different `recordId`, `column`, `table`, or `tenantId`)
  fails GCM tag verification and surfaces as
  `AuthorizationError(AAD_MISMATCH)` — not a generic decrypt error,
  because the security signal is "someone moved a ciphertext".
- **KEK rotation** is in-place: `rotateKek({tenantId})` bumps the
  key version; historical wrapped DEKs continue to unwrap because the
  wrap carries the prior version id. Search keys (ADR 0010) are
  derived under a separate HKDF info string so blind indexes survive.
- **Crypto-shred** is a pure intent boundary: `planCryptoShred`
  returns `{nextValue: null, reason, ...binding}` with a frozen
  reason vocabulary. Callers apply the plan inside a command-handler
  transaction so the storage write, audit row, and outbox event
  commit atomically.

## Consequences

**Easier:**

- A stolen database snapshot is useless without KMS access.
- Crypto-shredding a patient is a single CAS update that nulls every
  `*Enc` and `*Bi` column on the row; the row stays for FK integrity,
  the ciphertexts become unreadable.
- The AAD binding means an attacker with read+write on the DB still
  cannot move ciphertexts between rows — a meaningful raise above
  TDE.

**Harder:**

- Every PHI write goes through `encryptField`; every PHI read goes
  through `decryptField`. We accept the latency cost (microseconds
  per field with the local KMS path, more with AWS KMS).
- Search on PHI requires a separate strategy (blind indexes — see
  ADR 0010). Direct `WHERE firstName = ?` queries are impossible
  by construction.
- `apps/web` and `apps/worker` must agree on the KMS configuration or
  rows encrypted by one process are undecryptable by the other.
  `configureCrypto` is the boot singleton and throws
  `InternalError(CRYPTO_NOT_CONFIGURED)` when read before configuration.

**Ongoing obligations:**

- New PHI columns are named `*Enc` (`Json`) and registered against
  the blind-index purpose registry if searchable.
- KMS production credentials are managed out of band; `LocalKmsAdapter`
  is fatal in production.

## Alternatives Considered

- **Postgres TDE / pgcrypto column encryption with a single key.**
  No per-tenant isolation, no AAD binding, no crypto-shred path
  short of `DELETE FROM patient`.
- **Whole-row encryption.** No partial-field reads without decrypting
  the whole row. Performance cliff and wider blast radius on any
  decrypt bug.
- **Searchable encryption (deterministic AES, OPE).** Deterministic
  is equivalent to a blind index with worse separation; OPE leaks
  ordering. We prefer the explicit blind-index design of ADR 0010.

## References

- ADR 0010 — Blind indexes for PHI search via HMAC-SHA-256
- `packages/crypto/` — `encryptField`, `decryptField`, `LocalKmsAdapter`, `planCryptoShred`
- `docs/IMPLEMENTATION_PLAN.md` Phase 1 (`@pharmax/crypto`)
- `docs/ARCHITECTURE_PRINCIPLES.md` §B.4
