# 0010 — Blind indexes for PHI search via HMAC-SHA-256 with per-tenant per-purpose keys

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** security, phi, search

## Context

Operators routinely need to find a patient by name, DOB, phone, email,
or MRN. Under ADR 0005, PHI is stored as a per-record AES-GCM
ciphertext that is non-deterministic and authenticated against
`{tenantId, table, column, recordId}` — direct `WHERE firstName = ?`
is impossible by construction.

The naive workaround — decrypt every patient row server-side and
filter in memory — is unacceptable: it leaks the entire PHI table to
any process executing a search, costs a KMS unwrap per row, and
cannot use a database index. Searchable-encryption schemes
(deterministic AES, OPE, CipherSweet) introduce their own risks
(repetition leakage, ordering leakage, library bugs). We need
something simpler, auditable, and well-isolated across tenants,
columns, and tables.

## Decision

Add a parallel **blind-index column** (`*Bi`) next to every searchable
PHI envelope column (`*Enc`). The blind index is a deterministic
HMAC-SHA-256 over a normalized form of the plaintext, keyed by a
**per-tenant per-purpose** search key.

- `blindIndex(value, {tenantId, purpose})` is HMAC-SHA-256 over
  `normalize(value)` keyed by `searchKey(tenantId, purpose)`,
  base64url-encoded. Returns `null` for empty-normalized values.
- **Search keys** are derived from the per-tenant KEK via HKDF-SHA-256
  with info `pharmax.search.v1.<tenantId>.<purpose>`. They are
  **decoupled from KEK lifecycle** so blind indexes survive KEK
  rotation (ADR 0005). Per-tenant + per-purpose isolation means the
  same plaintext produces different hashes across tenants and columns.
- **Purposes** are registered in
  `packages/database/src/phi/blind-index-purposes.ts`. A contract
  test asserts every `*Bi` column has a documented purpose, no two
  purposes collide, and related-but-distinct purposes (`dobBi` vs
  `dobYearMonthBi`) do not cross-contaminate.
- **Normalizers** lock in equivalence classes deliberately:
  `normalizeForBlindIndex` is lowercase + trim + NFD-strip-combining-
  marks + whitespace-collapse, so "Café" matches "Cafe" matches "jane".
  `normalizePhoneForBlindIndex` is digits-only, last-10. Domain
  normalizers reject malformed shapes at the input boundary.
- Search is an **equality query on a btree index over
  `(organizationId, *Bi)`** — no scan, no decrypt fan-out. The caller
  never decrypts on behalf of the user; two patients can share a
  name-BI hash and differ on DOB, so trusting the hash alone is a
  security bug (loudly documented at the call site).

## Consequences

**Easier:**

- Sub-millisecond patient lookup by lowercased-trimmed name, by
  digits-only phone, or by full or year-month DOB.
- Per-tenant search-key isolation: a leaked hash from tenant A
  cannot be used to probe tenant B.
- KEK rotation is decoupled — search columns keep working without
  re-derivation.

**Harder:**

- Hash collisions exist. The caller MUST disambiguate with a
  secondary check (DOB + name + MRN, etc.) and MUST not surface
  the entire BI-matched set without further filtering. The call
  sites carry loud comments explaining this.
- Fuzzy / partial / phonetic search is **not supported**. By design.
  "Type at least three characters of the last name AND the DOB" is
  the search UX; we will not build broad decrypted PHI search.
- Adding a new searchable PHI column requires four changes in
  lockstep: schema (`*Bi` column), purpose registry, normalizer
  selection, write-time hashing. The contract tests fail until all
  four are aligned.

**Ongoing obligations:**

- Every `*Bi` column has a registered purpose.
- The normalizer hint is one of `text`/`phone`/`raw`.
- Crypto-shred plans cover both `*Enc` and `*Bi` columns so a
  shredded patient does not retain searchable hashes.

## Alternatives Considered

- **Deterministic AES on PHI columns.** Equivalent to a blind
  index over the same key, but with worse separation properties
  (one key per tenant rather than one per tenant per purpose).
- **Order-preserving encryption.** Leaks ordering; unacceptable for
  PHI ranges (DOB, last-modified, etc.).
- **Encrypted full-text indexes (CipherSweet bloom).** More
  expressive, but more complex; we have not needed prefix or fuzzy
  search yet, so the surface area is unjustified.
- **Decrypt-and-scan at the API layer.** Catastrophic at scale and
  PHI surface area; non-starter.

## References

- ADR 0005 — Envelope encryption per PHI field with AAD binding
- `packages/crypto/` — `blindIndex`, `normalizeForBlindIndex`, `normalizePhoneForBlindIndex`
- `packages/database/src/phi/blind-index-purposes.ts`
- `packages/patients/` — `PATIENT_BLIND_INDEX` namespace, `buildSearchWhere`
- `docs/ARCHITECTURE_PRINCIPLES.md` §B.4
