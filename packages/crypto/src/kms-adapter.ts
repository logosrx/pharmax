// KmsAdapter — the seam between this package and the key store.
//
// Production binds an AWS KMS adapter. Local dev / tests bind
// `LocalKmsAdapter`. The adapter is the ONLY place that holds key
// material in plaintext for longer than a single encryption operation.
//
// Four responsibilities:
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
//   4. **Audit-Merkle-root signing/verification.** The daily Merkle
//      job (ADR-0024) hands the adapter a 32-byte Merkle root plus
//      tenant + window context, gets back a detached signature plus
//      the `kmsKeyId` that produced it. Production binds this to the
//      AWS KMS asymmetric audit-signing key (KeyUsage = SIGN_VERIFY,
//      ECDSA / RSASSA_PSS). Local dev binds an HMAC-SHA-256 path —
//      symmetric, in-process, deterministic per-seed — so manifests
//      survive a process restart in dev/test without a KMS round-trip.
//      The signing seam lives on this adapter (rather than in a
//      bespoke `MerkleRootSigner` port) so production rotation,
//      auditing, and IAM scope-down all flow through one place.
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

/**
 * Input to `signRoot` / `verifyRoot`. The Merkle root is the SHA-256
 * tree root over a tenant's audit_log entryHashes for [windowStart,
 * windowEnd). Tenant + window are bound into the signed preimage so
 * an attacker cannot swap a manifest between tenants or between
 * days.
 */
export interface SignRootInput {
  readonly tenantId: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  /** 32-byte Merkle root. Caller is responsible for byte-equivalence. */
  readonly root: Buffer;
  /** Number of audit_log rows committed by `root` (informational; included in the preimage). */
  readonly leafCount: number;
}

export interface SignRootOutput {
  readonly signature: Buffer;
  /**
   * Stable identifier of the signing key. Production: AWS KMS Key
   * ARN. Local: a synthetic `local-hmac-sha256:<seed-hash>` value so
   * manifests can be re-verified across process restarts when the
   * seed is stable.
   */
  readonly kmsKeyId: string;
  /** Stable algorithm tag committed to the manifest. */
  readonly signatureAlgorithm: SignatureAlgorithm;
  readonly signedAt: Date;
}

export interface VerifyRootInput extends SignRootInput {
  readonly signature: Buffer;
  readonly kmsKeyId: string;
  readonly signatureAlgorithm: SignatureAlgorithm;
}

/**
 * Stable identifiers for the supported audit-Merkle signing
 * algorithms. The local adapter uses HMAC-SHA-256 (symmetric); the
 * AWS adapter, when wired, will use one of the asymmetric variants.
 * Bumping this list is a key-rotation event because the verifier
 * dispatches on this tag.
 */
export type SignatureAlgorithm =
  | "HMAC_SHA_256"
  | "ECDSA_SHA_256"
  | "ECDSA_SHA_384"
  | "RSASSA_PSS_SHA_256";

export interface KmsAdapter {
  /** Generate a fresh DEK and wrap it under the current per-tenant KEK. */
  generateDataKey(input: { readonly tenantId: string }): Promise<GenerateDataKeyResult>;

  /** Unwrap a previously-wrapped DEK. The `kid` selects the KEK version. */
  unwrapDataKey(input: UnwrapDataKeyInput): Promise<Buffer>;

  /** Derive a deterministic, per-tenant, per-purpose 32-byte search key. */
  deriveSearchKey(input: DeriveSearchKeyInput): Promise<Buffer>;

  /** Returns the current KEK identifier for this tenant (`kek:org-x:v<N>`). */
  currentKid(input: { readonly tenantId: string }): Promise<string>;

  /**
   * Sign a daily audit-Merkle root + windowing context. The adapter
   * is the only place that holds the signing key material; callers
   * supply the root (32 bytes) and tenant/window metadata, and get
   * back a detached signature plus the resolved key id.
   *
   * Local dev: HMAC-SHA-256 against a tenant-bound key derived from
   * the master seed. Symmetric, deterministic, no asymmetric crypto
   * — sufficient for tamper-evidence inside a single trust boundary.
   *
   * Production: AWS KMS asymmetric `Sign` against the audit-signing
   * key. The AwsKmsAdapter implementation lands behind this contract.
   */
  signRoot(input: SignRootInput): Promise<SignRootOutput>;

  /**
   * Verify a previously-signed root. Returns `true` on success,
   * `false` on signature mismatch or algorithm/key-id mismatch.
   * Callers receive a boolean (not a throw) so verification loops
   * can iterate many manifests and tally pass/fail without
   * try/catch noise.
   */
  verifyRoot(input: VerifyRootInput): Promise<boolean>;
}

/**
 * Length-prefixed canonical preimage for `signRoot` / `verifyRoot`.
 * Exposed so the verifier script and tests can reproduce the bytes
 * that get signed without depending on a specific adapter.
 *
 * Format (length-prefixed, big-endian uint32 lengths):
 *
 *   pharmax/audit-merkle/v1
 *   tenantId         (UTF-8)
 *   windowStart      (ISO-8601 UTC)
 *   windowEnd        (ISO-8601 UTC)
 *   root             (32 bytes)
 *   leafCount        (uint64 BE, 8 bytes)
 */
export function buildAuditMerkleSigningPreimage(input: SignRootInput): Buffer {
  const parts: Buffer[] = [];

  function appendLengthPrefixed(value: Buffer): void {
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(value.length, 0);
    parts.push(lengthBuffer);
    parts.push(value);
  }

  appendLengthPrefixed(Buffer.from(AUDIT_MERKLE_SIGNING_DOMAIN_TAG, "utf8"));
  appendLengthPrefixed(Buffer.from(input.tenantId, "utf8"));
  appendLengthPrefixed(Buffer.from(input.windowStart.toISOString(), "utf8"));
  appendLengthPrefixed(Buffer.from(input.windowEnd.toISOString(), "utf8"));
  appendLengthPrefixed(Buffer.from(input.root));

  const leafCountBuffer = Buffer.alloc(8);
  if (!Number.isInteger(input.leafCount) || input.leafCount < 0) {
    throw new RangeError(
      `buildAuditMerkleSigningPreimage: leafCount must be a non-negative integer (got ${String(input.leafCount)}).`
    );
  }
  leafCountBuffer.writeBigUInt64BE(BigInt(input.leafCount), 0);
  appendLengthPrefixed(leafCountBuffer);

  return Buffer.concat(parts);
}

/**
 * Domain-separation tag for the audit-Merkle signing preimage.
 * Bumping this string invalidates every previously-signed manifest;
 * treat it as a chain-format version bump (same change-control as
 * the audit TLV encoder).
 */
export const AUDIT_MERKLE_SIGNING_DOMAIN_TAG = "pharmax/audit-merkle/v1";
