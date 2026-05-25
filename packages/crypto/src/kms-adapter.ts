// KmsAdapter — the seam between this package and the key store.
//
// Production binds an AWS KMS adapter. Local dev / tests bind
// `LocalKmsAdapter`. The adapter is the ONLY place that holds key
// material in plaintext for longer than a single encryption operation.
//
// Three responsibilities:
//
//   1. **Data Encryption Keys (DEKs).** Per-encrypt-operation 32-byte
//      keys. The adapter generates one and returns BOTH the plaintext
//      (used immediately to encrypt the field, then zeroed) AND the
//      KEK-wrapped version (stored in the envelope). On decrypt, the
//      adapter unwraps the wrapped DEK.
//
//   2. **Per-tenant search keys.** A separate keyed-HMAC derivation
//      used for blind indexes. Deterministic per tenant — the same
//      value normalizes to the same blind index across rows so we
//      can SELECT … WHERE _bid = $1.
//
//   3. **KEK identification.** Every wrapped DEK carries a `kid`
//      (key identifier) that says which KEK was used. Required for
//      KEK rotation: the wrapped DEK from kid `kek:org-x:v3` MUST be
//      unwrappable even after kid `kek:org-x:v4` becomes current.
//
// What the adapter does NOT do:
//   - Encrypt/decrypt fields directly. That's `encryptField`'s job;
//     the adapter only handles the key.
//   - AAD validation. The field cipher carries AAD; the adapter is
//     AAD-agnostic.
//   - Crypto-shred. Shredding is a storage-layer operation that
//     overwrites the envelope; no KMS call required.
//
// Tenant model: every operation is scoped to a `tenantId`. Cross-
// tenant key access is impossible from this interface — the prod
// adapter enforces it via IAM, the local adapter via HKDF separation.

export interface GenerateDataKeyResult {
  /** Stable identifier of the KEK used to wrap (e.g. `kek:org-x:v3`). */
  readonly kid: string;
  /** 32 bytes. Used immediately to encrypt; the caller zeroes this after use. */
  readonly plaintextDek: Buffer;
  /** KEK-wrapped DEK to store in the envelope. */
  readonly wrappedDek: Buffer;
}

export interface UnwrapDataKeyInput {
  readonly tenantId: string;
  readonly kid: string;
  readonly wrappedDek: Buffer;
}

export interface DeriveSearchKeyInput {
  readonly tenantId: string;
  /**
   * Per-(table, column) salt so the blind index for `patient.first_name`
   * doesn't collide with the one for `patient.last_name`.
   */
  readonly purpose: string;
}

export interface KmsAdapter {
  /** Generate a fresh DEK and wrap it under the current per-tenant KEK. */
  generateDataKey(input: { readonly tenantId: string }): Promise<GenerateDataKeyResult>;

  /** Unwrap a previously-wrapped DEK. The `kid` selects the KEK version. */
  unwrapDataKey(input: UnwrapDataKeyInput): Promise<Buffer>;

  /** Derive a deterministic, per-tenant, per-purpose 32-byte search key. */
  deriveSearchKey(input: DeriveSearchKeyInput): Promise<Buffer>;

  /** Returns the current KEK identifier for this tenant (`kek:org-x:v<N>`). */
  currentKid(input: { readonly tenantId: string }): Promise<string>;
}
