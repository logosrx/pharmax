// AwsKmsAdapter — production KMS binding.
//
// Replaces `LocalKmsAdapter` in `apps/web` and `apps/worker` once
// `NODE_ENV=production`. The interface is identical to
// `LocalKmsAdapter` (same `KmsAdapter` contract) so the rest of the
// crypto package — `encryptField`, `decryptField`, `blindIndex` —
// does not change.
//
// Two AWS KMS keys are required, NOT one:
//
//   1. A SYMMETRIC `ENCRYPT_DECRYPT` key (`dataKeyKeyId`). This wraps
//      per-encryption DEKs. AWS KMS's `GenerateDataKey` returns the
//      plaintext DEK (used immediately, then zeroed) and the wrapped
//      DEK (stored in the envelope). `Decrypt` round-trips the same
//      wrapped DEK back to plaintext.
//
//   2. An HMAC `GENERATE_VERIFY_MAC` `HMAC_256` key (`searchKeyKeyId`).
//      KMS's `Mac` operation produces a deterministic 32-byte MAC for
//      a given message. We use it to derive per-tenant, per-purpose
//      search keys for blind indexes. Deterministic is essential —
//      the same (tenantId, purpose) MUST yield the same key across
//      every process or blind-index reads break.
//
// Two keys, not one, because AWS KMS forbids mixing key usages on a
// single key: a key with `KeyUsage = ENCRYPT_DECRYPT` cannot perform
// `Mac`, and vice versa. The Terraform module creates both side by
// side.
//
// Cryptographic tenant binding:
//
//   Every `GenerateDataKey` and `Decrypt` call passes
//   `EncryptionContext = { tenantId }`. AWS KMS treats this as
//   additional authenticated data on the DEK wrap: a wrapped DEK
//   produced for tenant A literally cannot be decrypted if the caller
//   passes tenant B's id. This is the cryptographic layer on top of
//   the application-level tenancy gate — defence in depth for cross-
//   tenant PHI access attempts.
//
//   Field-level AAD (record binding from `aad.ts`) is SEPARATE. KMS
//   EncryptionContext protects the DEK wrap; field AAD protects the
//   ciphertext-to-record link. Both must verify for a decrypt to
//   succeed.
//
// Search-key caching:
//
//   `deriveSearchKey` is called on every blind-index read (PHI
//   search). A KMS round-trip per query is unacceptable latency-wise
//   AND cost-wise. We memoize results in an in-process `Map` keyed
//   by `${tenantId}::${purpose}`. The cache lives for the process
//   lifetime; restarting the process re-fetches. Cache entries do
//   not expire because search keys do not change unless the
//   underlying HMAC KMS key is rotated, which is an out-of-band
//   operational event (and the process should be restarted as part
//   of any KMS key rotation).
//
//   The cached Buffer is the raw 32-byte key. We do NOT zero it on
//   eviction (we never evict). If process memory disclosure is a
//   concern, restart the process — the same threat model applies to
//   the LocalKmsAdapter.
//
// Boot-time validation:
//
//   The constructor accepts the two key IDs as opaque strings (ARN,
//   key id, or alias). The first time `validate()` is called (the
//   bootstrap layer calls it explicitly before declaring boot
//   complete), we ping KMS with `DescribeKey` against both keys.
//   This surfaces IAM misconfig (most common: task role missing
//   `kms:DescribeKey` permission) as a clear boot-time failure
//   rather than a silent first-PHI-write failure.
//
// kid format:
//
//   `aws:kek:<keyId>:<tenantId>:v1`
//
//   The `aws:` prefix mechanically distinguishes AwsKmsAdapter kids
//   from LocalKmsAdapter kids in stored envelopes. The trailing `v1`
//   slot is reserved for explicit application-level KEK epoch
//   rotation; in practice we ride AWS KMS's automatic key material
//   rotation (annual on customer-managed keys with rotation enabled)
//   and the epoch stays at v1 forever. If we ever need a hard
//   cutover (e.g. after a confirmed key compromise), the procedure
//   is documented in `docs/RUNBOOK.md#rotating-a-kms-data-key`.

import { cryptoValidationError, decryptFailedError, kmsKeyNotFoundError } from "./errors.js";
import type {
  DeriveSearchKeyInput,
  GenerateDataKeyResult,
  KmsAdapter,
  SignRootInput,
  SignRootOutput,
  UnwrapDataKeyInput,
  VerifyRootInput,
} from "./kms-adapter.js";

const DEK_BYTES = 32;
const SEARCH_KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// Minimal KMS client surface used by this adapter.
//
// We intentionally do NOT import `@aws-sdk/client-kms` types here.
// The adapter accepts any object that implements these three method
// signatures. In production, you pass `createAwsKmsClient(...)` which
// thinly wraps `KMSClient`. In tests, you pass a hand-rolled fake.
// This:
//   - Keeps the @aws-sdk dependency optional from this file's
//     perspective (the SDK is only imported by the factory below).
//   - Makes unit testing trivial — no nock, no aws-sdk-client-mock.
//   - Keeps the contract surface small enough to audit by eye.
// ---------------------------------------------------------------------------

export interface AwsKmsGenerateDataKeyInput {
  readonly KeyId: string;
  readonly KeySpec: "AES_256";
  readonly EncryptionContext: Readonly<Record<string, string>>;
}

export interface AwsKmsGenerateDataKeyOutput {
  readonly Plaintext: Uint8Array;
  readonly CiphertextBlob: Uint8Array;
}

export interface AwsKmsDecryptInput {
  readonly KeyId: string;
  readonly CiphertextBlob: Uint8Array;
  readonly EncryptionContext: Readonly<Record<string, string>>;
}

export interface AwsKmsDecryptOutput {
  readonly Plaintext: Uint8Array;
}

export interface AwsKmsMacInput {
  readonly KeyId: string;
  readonly Message: Uint8Array;
  readonly MacAlgorithm: "HMAC_SHA_256";
}

export interface AwsKmsMacOutput {
  readonly Mac: Uint8Array;
}

export interface AwsKmsDescribeKeyInput {
  readonly KeyId: string;
}

export interface AwsKmsDescribeKeyOutput {
  readonly KeyMetadata: {
    readonly KeyId: string;
    readonly Arn?: string;
    readonly KeyUsage?: string;
    readonly KeySpec?: string;
    readonly Enabled?: boolean;
  };
}

/**
 * Minimal KMS client surface required by the adapter.
 *
 * In production this is satisfied by `createAwsKmsClient()` (below),
 * which delegates to `@aws-sdk/client-kms`. In tests, hand-rolled
 * fakes implement the same shape.
 */
export interface AwsKmsClient {
  generateDataKey(input: AwsKmsGenerateDataKeyInput): Promise<AwsKmsGenerateDataKeyOutput>;
  decrypt(input: AwsKmsDecryptInput): Promise<AwsKmsDecryptOutput>;
  mac(input: AwsKmsMacInput): Promise<AwsKmsMacOutput>;
  describeKey(input: AwsKmsDescribeKeyInput): Promise<AwsKmsDescribeKeyOutput>;
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export interface AwsKmsAdapterOptions {
  /** AWS KMS client. In prod this comes from `createAwsKmsClient`. */
  readonly client: AwsKmsClient;
  /**
   * KMS key for DEK generation + unwrap. Must be a symmetric
   * `ENCRYPT_DECRYPT` customer-managed key. Accepts a key id, a key
   * ARN, or an alias (`alias/pharmax/app-phi-key`).
   */
  readonly dataKeyKeyId: string;
  /**
   * KMS key for deterministic per-tenant search-key derivation. Must
   * be an HMAC key with KeySpec `HMAC_256` (so the resulting MAC is
   * 32 bytes — matches our 32-byte search-key convention). Accepts a
   * key id, ARN, or alias.
   */
  readonly searchKeyKeyId: string;
  /**
   * Optional. Short identifier used inside the `kid` string we
   * persist in envelopes. Defaults to a sanitized form of
   * `dataKeyKeyId`. Keep stable across deploys — changing it would
   * produce kids that don't parse against existing envelopes (which
   * would break decrypt).
   *
   * Recommended: a short stable string like `"app-phi"` (matches the
   * Terraform alias name without the `alias/pharmax/` prefix).
   */
  readonly keyIdLabel?: string;
}

export class AwsKmsAdapter implements KmsAdapter {
  private readonly client: AwsKmsClient;
  private readonly dataKeyKeyId: string;
  private readonly searchKeyKeyId: string;
  private readonly keyIdLabel: string;
  // Cache the in-flight Promise rather than the resolved Buffer so two
  // concurrent `deriveSearchKey` calls for the same (tenant, purpose)
  // collapse to ONE KMS round-trip — DataLoader-style coalescing.
  // Resolved Promises stay in the Map for the process lifetime; we
  // never evict (search keys are stable, the cache is small, and a
  // restart is the rotation path).
  private readonly searchKeyCache = new Map<string, Promise<Buffer>>();
  private validated = false;

  public constructor(options: AwsKmsAdapterOptions) {
    requireNonEmpty(options.dataKeyKeyId, "dataKeyKeyId");
    requireNonEmpty(options.searchKeyKeyId, "searchKeyKeyId");
    this.client = options.client;
    this.dataKeyKeyId = options.dataKeyKeyId;
    this.searchKeyKeyId = options.searchKeyKeyId;
    this.keyIdLabel = options.keyIdLabel ?? sanitizeKeyIdForLabel(options.dataKeyKeyId);
  }

  /**
   * Verify both KMS keys are reachable, of the expected type, and
   * enabled. The bootstrap layer calls this once during boot so
   * misconfig surfaces immediately. Cheap (two `DescribeKey` calls),
   * idempotent — a second call after a successful first one is a
   * no-op and does NOT round-trip to KMS.
   *
   * Invariants enforced (all must hold for both keys before this
   * method returns):
   *
   *   - The key is reachable via `DescribeKey` (i.e. the IAM
   *     principal has `kms:DescribeKey` and the key exists).
   *   - `Enabled === true`. A disabled key cannot encrypt or
   *     decrypt; treating any non-true value as failure (rather
   *     than `=== false`) means a missing-field response from a
   *     spoofed or future SDK shape still fails closed.
   *   - The data key has `KeyUsage === "ENCRYPT_DECRYPT"` and
   *     `KeySpec === "SYMMETRIC_DEFAULT"` (i.e. an AES-256 CMK
   *     that supports `GenerateDataKey` with `KeySpec=AES_256`).
   *   - The search key has `KeyUsage === "GENERATE_VERIFY_MAC"`
   *     and `KeySpec === "HMAC_256"` — required for the
   *     `GenerateMac` + `HMAC_SHA_256` algorithm pair we use.
   *
   * Throws on any violation; the error code is
   * `KMS_KEY_NOT_FOUND` for unreachable / disabled keys (so the
   * operator triages an IAM or key-state issue) and
   * `CRYPTO_VALIDATION` for type mismatches (so the operator
   * triages a Terraform / configuration issue). Error metadata
   * names the offending key id but never echoes credentials or
   * AWS principal info.
   */
  public async validate(): Promise<void> {
    if (this.validated) return;

    const dataKey = await this.describeOrThrow(this.dataKeyKeyId, "dataKeyKeyId");
    if (dataKey.KeyMetadata.Enabled !== true) {
      throw kmsKeyNotFoundError({
        tenantId: "(boot)",
        kid: `aws-kms describe(${this.dataKeyKeyId}): disabled`,
      });
    }
    // Strict comparison even when the SDK returns `undefined` for a
    // field — a missing field means the SDK shape changed under us
    // (future SDK or test fake). Fail closed: refuse to declare a
    // key valid until we positively see the expected type.
    if (dataKey.KeyMetadata.KeyUsage !== "ENCRYPT_DECRYPT") {
      throw cryptoValidationError({
        field: "dataKeyKeyId",
        reason: `expected KeyUsage=ENCRYPT_DECRYPT, got ${formatField(dataKey.KeyMetadata.KeyUsage)} for ${this.dataKeyKeyId}`,
      });
    }
    if (dataKey.KeyMetadata.KeySpec !== "SYMMETRIC_DEFAULT") {
      // `GenerateDataKey(KeySpec=AES_256)` only works against a
      // SYMMETRIC_DEFAULT CMK. An asymmetric or HMAC key here
      // would surface as a per-request failure later — refuse
      // at boot.
      throw cryptoValidationError({
        field: "dataKeyKeyId",
        reason: `expected KeySpec=SYMMETRIC_DEFAULT, got ${formatField(dataKey.KeyMetadata.KeySpec)} for ${this.dataKeyKeyId}`,
      });
    }

    const searchKey = await this.describeOrThrow(this.searchKeyKeyId, "searchKeyKeyId");
    if (searchKey.KeyMetadata.Enabled !== true) {
      throw kmsKeyNotFoundError({
        tenantId: "(boot)",
        kid: `aws-kms describe(${this.searchKeyKeyId}): disabled`,
      });
    }
    if (searchKey.KeyMetadata.KeyUsage !== "GENERATE_VERIFY_MAC") {
      throw cryptoValidationError({
        field: "searchKeyKeyId",
        reason: `expected KeyUsage=GENERATE_VERIFY_MAC, got ${formatField(searchKey.KeyMetadata.KeyUsage)} for ${this.searchKeyKeyId}`,
      });
    }
    if (searchKey.KeyMetadata.KeySpec !== "HMAC_256") {
      throw cryptoValidationError({
        field: "searchKeyKeyId",
        reason: `expected KeySpec=HMAC_256, got ${formatField(searchKey.KeyMetadata.KeySpec)} for ${this.searchKeyKeyId}`,
      });
    }

    this.validated = true;
  }

  public async currentKid(input: { readonly tenantId: string }): Promise<string> {
    requireNonEmpty(input.tenantId, "tenantId");
    return this.kidFor(input.tenantId);
  }

  /**
   * Internal: number of (tenantId, purpose) entries currently
   * cached. Exposed only for test/observability assertions; never
   * exposes the search-key bytes themselves.
   */
  public _searchKeyCacheSize(): number {
    return this.searchKeyCache.size;
  }

  public async generateDataKey(input: {
    readonly tenantId: string;
  }): Promise<GenerateDataKeyResult> {
    requireNonEmpty(input.tenantId, "tenantId");

    const result = await this.client.generateDataKey({
      KeyId: this.dataKeyKeyId,
      KeySpec: "AES_256",
      EncryptionContext: { tenantId: input.tenantId },
    });

    if (result.Plaintext.byteLength !== DEK_BYTES) {
      // Defensive: AES_256 must yield 32 bytes. If KMS ever returned
      // something else we'd silently produce ciphertexts the rest of
      // the package can't decrypt.
      throw cryptoValidationError({
        field: "Plaintext",
        reason: `KMS returned ${result.Plaintext.byteLength} bytes; expected ${DEK_BYTES}`,
      });
    }
    if (result.CiphertextBlob.byteLength === 0) {
      // A zero-length wrapped DEK would store an unrecoverable
      // envelope. Refuse rather than persist garbage that the next
      // decrypt would surface as `DECRYPT_FAILED`.
      throw cryptoValidationError({
        field: "CiphertextBlob",
        reason: "KMS returned a zero-length CiphertextBlob",
      });
    }

    return {
      kid: this.kidFor(input.tenantId),
      plaintextDek: Buffer.from(result.Plaintext),
      wrappedDek: Buffer.from(result.CiphertextBlob),
    };
  }

  public async unwrapDataKey(input: UnwrapDataKeyInput): Promise<Buffer> {
    requireNonEmpty(input.tenantId, "tenantId");
    if (!Buffer.isBuffer(input.wrappedDek) || input.wrappedDek.byteLength === 0) {
      throw cryptoValidationError({
        field: "wrappedDek",
        reason: "must be a non-empty Buffer",
      });
    }
    const parsed = parseAwsKid(input.kid);
    if (parsed === null) {
      // A non-AWS kid landed in front of this adapter. Most likely
      // cause: an envelope encrypted with the LocalKmsAdapter is
      // being read in production. Surface loudly — the operator
      // needs to know production memory is touching dev data.
      throw kmsKeyNotFoundError({ tenantId: input.tenantId, kid: input.kid });
    }
    if (parsed.tenantId !== input.tenantId) {
      // The kid embeds the tenant id; if it disagrees with the
      // caller-supplied tenantId, we refuse before even calling
      // KMS. Cross-tenant decrypt attempt — block + log.
      throw kmsKeyNotFoundError({ tenantId: input.tenantId, kid: input.kid });
    }
    if (parsed.keyIdLabel !== this.keyIdLabel) {
      // The envelope was wrapped under a different `keyIdLabel`
      // than this adapter is configured for. KMS-side, the
      // `Decrypt` would either succeed (if the underlying CMK
      // happens to be the same and only the alias changed) or
      // fail with a less actionable error. Refusing here gives a
      // clean signal to the operator that they're pointing the
      // adapter at the wrong CMK for these envelopes — the most
      // likely cause is a botched `AWS_KMS_KEY_LABEL` change.
      throw kmsKeyNotFoundError({ tenantId: input.tenantId, kid: input.kid });
    }

    let result: AwsKmsDecryptOutput;
    try {
      result = await this.client.decrypt({
        KeyId: this.dataKeyKeyId,
        CiphertextBlob: new Uint8Array(input.wrappedDek),
        EncryptionContext: { tenantId: input.tenantId },
      });
    } catch (cause) {
      // KMS returns InvalidCiphertextException if EncryptionContext
      // doesn't match what was used at wrap time. That is the
      // cryptographic enforcement layer: even if the caller's
      // application-level tenancy check is bypassed, KMS will not
      // hand out the plaintext DEK. We convert it to our internal
      // error code so the caller experiences the same shape as the
      // local adapter.
      throw decryptFailedError({
        reason: cause instanceof Error ? cause.message : "kms.decrypt failed",
        tenantId: input.tenantId,
        // Not a PHI surface — these fields are caller-supplied
        // record identifiers (ULIDs).
        table: "(kms.unwrapDataKey)",
        column: "(wrappedDek)",
        recordId: input.kid,
      });
    }

    if (result.Plaintext.byteLength !== DEK_BYTES) {
      throw cryptoValidationError({
        field: "Plaintext",
        reason: `KMS returned ${result.Plaintext.byteLength} bytes on decrypt; expected ${DEK_BYTES}`,
      });
    }

    return Buffer.from(result.Plaintext);
  }

  public async deriveSearchKey(input: DeriveSearchKeyInput): Promise<Buffer> {
    requireNonEmpty(input.tenantId, "tenantId");
    if (typeof input.purpose !== "string" || input.purpose.length === 0) {
      throw cryptoValidationError({ field: "purpose", reason: "must be non-empty" });
    }

    // Cache the in-flight Promise (not the resolved Buffer) so two
    // concurrent first-time callers for the same (tenantId, purpose)
    // collapse to a single KMS round-trip. On error, the entry is
    // evicted so the next caller can retry (otherwise a transient
    // failure would poison the cache for the process lifetime).
    const cacheKey = `${input.tenantId}::${input.purpose}`;
    const cached = this.searchKeyCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const pending = this.computeSearchKey(input.tenantId, input.purpose);
    this.searchKeyCache.set(cacheKey, pending);
    try {
      return await pending;
    } catch (cause) {
      this.searchKeyCache.delete(cacheKey);
      throw cause;
    }
  }

  private async computeSearchKey(tenantId: string, purpose: string): Promise<Buffer> {
    // Message format: bind tenant + purpose so the MAC is unique
    // per (tenant, purpose). The HMAC key itself is shared across
    // tenants, but the MAC output is cryptographically partitioned
    // by the message bytes. Including a stable version prefix lets
    // us migrate to a new derivation scheme later without colliding
    // with existing blind indexes.
    const message = Buffer.from(`pharmax.search.v1.${tenantId}.${purpose}`, "utf8");

    const result = await this.client.mac({
      KeyId: this.searchKeyKeyId,
      Message: new Uint8Array(message),
      MacAlgorithm: "HMAC_SHA_256",
    });

    if (result.Mac.byteLength !== SEARCH_KEY_BYTES) {
      throw cryptoValidationError({
        field: "Mac",
        reason: `KMS returned ${result.Mac.byteLength} bytes; expected ${SEARCH_KEY_BYTES}`,
      });
    }

    return Buffer.from(result.Mac);
  }

  /**
   * Audit-Merkle root signing via AWS KMS asymmetric `Sign`.
   *
   * Wiring lands in a parallel slice owned by the AwsKmsAdapter
   * agent. Until then, callers in production receive a clear error
   * code (`KMS_KEY_NOT_FOUND` with metadata describing the missing
   * wiring) rather than a silent no-op or a half-signed manifest.
   *
   * Local dev / test paths bind the LocalKmsAdapter, whose
   * `signRoot` is fully implemented (HMAC-SHA-256). The worker
   * drain goes through the `KmsAdapter` interface and so works
   * end-to-end against the local adapter without depending on the
   * AWS path being filled in.
   */
  public async signRoot(input: SignRootInput): Promise<SignRootOutput> {
    throw kmsKeyNotFoundError({
      tenantId: input.tenantId,
      kid: "aws-kms.signRoot is not yet wired; AwsKmsAdapter audit-signing key is provisioned in a parallel slice (ADR-0024).",
    });
  }

  public async verifyRoot(input: VerifyRootInput): Promise<boolean> {
    throw kmsKeyNotFoundError({
      tenantId: input.tenantId,
      kid: "aws-kms.verifyRoot is not yet wired; AwsKmsAdapter audit-signing key is provisioned in a parallel slice (ADR-0024).",
    });
  }

  // ---- private helpers ----

  private kidFor(tenantId: string): string {
    return `aws:kek:${this.keyIdLabel}:${tenantId}:v1`;
  }

  /**
   * Call `DescribeKey` and surface a typed error tied to the
   * configured field name. We translate transport-level failures
   * (timeout, IAM AccessDenied, NotFound) into our internal
   * `KMS_KEY_NOT_FOUND` shape so the boot path produces a single
   * error code regardless of which lower-layer reason caused the
   * call to fail. The original cause is preserved as the `cause`
   * field for Sentry/OTel correlation but never re-thrown to
   * the caller.
   */
  private async describeOrThrow(
    keyId: string,
    field: "dataKeyKeyId" | "searchKeyKeyId"
  ): Promise<AwsKmsDescribeKeyOutput> {
    try {
      return await this.client.describeKey({ KeyId: keyId });
    } catch (cause) {
      throw kmsKeyNotFoundError({
        tenantId: "(boot)",
        kid: `aws-kms describe(${keyId}) failed for ${field}: ${
          cause instanceof Error ? cause.message : "unknown"
        }`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// kid parsing.
// ---------------------------------------------------------------------------

const AWS_KID_RE = /^aws:kek:([^:]+):([^:]+):v(\d+)$/;

interface ParsedAwsKid {
  readonly keyIdLabel: string;
  readonly tenantId: string;
  readonly version: number;
}

function parseAwsKid(kid: string): ParsedAwsKid | null {
  if (typeof kid !== "string") return null;
  const m = AWS_KID_RE.exec(kid);
  if (m === null) return null;
  const keyIdLabel = m[1];
  const tenantId = m[2];
  const versionStr = m[3];
  if (keyIdLabel === undefined || tenantId === undefined || versionStr === undefined) return null;
  const version = Number.parseInt(versionStr, 10);
  if (!Number.isFinite(version) || version < 1) return null;
  return { keyIdLabel, tenantId, version };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw cryptoValidationError({ field, reason: "must be a non-empty string" });
  }
}

/**
 * Render a `KeyUsage` / `KeySpec` value for the validation-error
 * message. We never log secrets here — only the metadata strings
 * AWS returned (or the literal token `"<missing>"` when the field
 * is undefined). Avoids `undefined` rendering as the string
 * `"undefined"` which would be a confusing operator message.
 */
function formatField(value: string | undefined): string {
  return typeof value === "string" ? value : "<missing>";
}

/**
 * Strip non-label characters from a KMS key id / ARN / alias for use
 * in the persistent `kid` string. We strip colons + slashes + the
 * leading `arn:aws:kms:<region>:<account>:` because:
 *
 *   - Colons are our kid separator; embedding raw ARN inside would
 *     break `parseAwsKid`.
 *   - Stripping the account id from the kid keeps PII (yes,
 *     account ids are PII for HIPAA purposes in some readings) out
 *     of the persistent storage layer.
 *
 * Examples:
 *   `alias/pharmax/app-phi-key` → `alias-pharmax-app-phi-key`
 *   `arn:aws:kms:us-east-1:123:key/abc-def` → `key-abc-def`
 *   `abc-def-ghi`               → `abc-def-ghi`
 */
export function sanitizeKeyIdForLabel(keyId: string): string {
  // For ARNs, take the part after the last colon, which is `key/<id>`
  // or `alias/<name>`. For aliases passed as `alias/<name>`, leave as
  // is. For raw key ids, leave as is. Then replace colons/slashes
  // with hyphens so the result is kid-safe.
  const lastColon = keyId.lastIndexOf(":");
  const tail = lastColon >= 0 ? keyId.slice(lastColon + 1) : keyId;
  return tail.replace(/[:/]/g, "-");
}
