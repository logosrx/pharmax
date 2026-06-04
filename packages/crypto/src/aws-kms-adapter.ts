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

import { getMeter } from "@pharmax/telemetry";

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

const meter = getMeter("@pharmax/crypto");

/**
 * Incremented every time `unwrapDataKey` succeeds against a key that
 * is NOT the current `dataKeyKeyId`. Labels:
 *   - `key_position` — 1-indexed position in `previousDataKeyKeyIds`
 *     (so `key_position=1` is "the first historical key", which is
 *     usually the most recent one before the rotation).
 *
 * Why this is worth a metric: CMK identity rotation is an
 * operator-triggered event with a defined bake-in window. Production
 * monitors this counter to confirm (a) the historical-key fallback
 * is genuinely needed during a rotation, and (b) traffic has drained
 * off the historical key before the operator drops it from
 * `AWS_KMS_PREVIOUS_DATA_KEY_IDS` and revokes IAM grants.
 *
 * A non-zero rate AFTER a planned rotation's bake-in window has
 * elapsed indicates dark data (an envelope no recent code path has
 * touched) still bound to the old CMK — block the IAM revocation
 * until the rate returns to zero.
 */
const kmsHistoricalKeyHitsCounter = meter.createCounter(
  "pharmax_kms_decrypt_historical_key_hits_total",
  {
    description:
      "AwsKmsAdapter.unwrapDataKey succeeded against a historical CMK (not the current dataKeyKeyId) during a CMK identity rotation. Labelled by 1-indexed position in previousDataKeyKeyIds. A non-zero rate AFTER the bake-in window means dark envelopes still bind to the old CMK — block IAM revocation until this returns to zero.",
  }
);

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
  /**
   * Optional list of historical `ENCRYPT_DECRYPT` CMK ARNs/aliases
   * that previously wrapped DEKs and remain decrypt-eligible during a
   * **manual CMK identity rotation** (see RUNBOOK §
   * "Rotating a KMS data key — Manual CMK rotation").
   *
   * Why this option exists
   * ----------------------
   *
   * `kms.Decrypt` validates that the `KeyId` parameter matches the
   * CMK identity baked into the ciphertext blob. After an alias-swap
   * rotation (new CMK behind the same alias name; old CMK still
   * exists with `Decrypt`-only grants for the bake-in window),
   * envelopes wrapped under the OLD CMK now fail Decrypt against the
   * NEW CMK's id. The kid stored in our envelopes (which embeds the
   * `keyIdLabel`, NOT the CMK ARN) cannot disambiguate which CMK to
   * try, so the adapter walks this list as a fallback.
   *
   * Behavioral contract
   * -------------------
   *
   *   1. Steady state (no rotation in flight): leave undefined or
   *      empty. The adapter performs exactly ONE Decrypt call per
   *      unwrap (zero behavioral change, zero added latency).
   *   2. During rotation bake-in: populate with the OLD CMK ARN(s).
   *      `unwrapDataKey` tries the current `dataKeyKeyId` first; on
   *      failure, walks this list in declared order, returning the
   *      first successful decrypt and incrementing
   *      `pharmax_kms_decrypt_historical_key_hits_total`. When ALL
   *      keys fail, the error returned is the LAST attempt's failure
   *      (most informative for diagnosis).
   *   3. Post-rotation cutover: drop entries from this list as their
   *      hit-rate drains to zero in the metric above. Coordinate
   *      with IAM revocation — never remove a key from this list
   *      while traffic still targets it.
   *
   * Validation invariants (enforced in `validate()`)
   * -----------------------------------------------
   *
   *   - Each entry is `DescribeKey`-reachable AND `Enabled === true`
   *     AND `KeyUsage === ENCRYPT_DECRYPT` AND `KeySpec === SYMMETRIC_DEFAULT`.
   *   - Duplicate entries (or duplicates of `dataKeyKeyId`) throw
   *     `CRYPTO_VALIDATION` from the constructor — silently allowing
   *     them would inflate the decrypt-attempt budget on every
   *     historical envelope.
   *
   * SOC 2 mapping
   * -------------
   *
   * Closes the `kms2` follow-up in
   * `docs/security/kms-key-inventory.md` § 7 and `docs/soc2/
   * code-evidence-map.md`. The supporting envelope kid invariant
   * (no kid change across identity rotation) is documented in
   * `docs/RUNBOOK.md` § "Rotating a KMS data key — Manual CMK
   * rotation".
   */
  readonly previousDataKeyKeyIds?: ReadonlyArray<string>;
}

export class AwsKmsAdapter implements KmsAdapter {
  private readonly client: AwsKmsClient;
  private readonly dataKeyKeyId: string;
  private readonly searchKeyKeyId: string;
  private readonly keyIdLabel: string;
  // Frozen at construction time. Iterated in declared order on
  // unwrap fallback (see `unwrapDataKey`). Empty when no rotation is
  // in flight — the adapter performs exactly one Decrypt call in
  // that case (no behavioral change vs. pre-rotation deployments).
  private readonly previousDataKeyKeyIds: ReadonlyArray<string>;
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
    this.previousDataKeyKeyIds = validatePreviousDataKeyKeyIds(
      options.previousDataKeyKeyIds,
      options.dataKeyKeyId
    );
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

    // Historical CMKs from a rotation in flight. Validated with the
    // SAME shape as the current key — Enabled + ENCRYPT_DECRYPT +
    // SYMMETRIC_DEFAULT. A misconfigured historical entry (typo'd
    // ARN, missing IAM grant, key disabled by accident) fails at
    // boot rather than at first-historical-envelope-decrypt — which
    // could be hours or days into traffic.
    for (let index = 0; index < this.previousDataKeyKeyIds.length; index += 1) {
      const previousKeyId = this.previousDataKeyKeyIds[index]!;
      const fieldLabel = `previousDataKeyKeyIds[${index}]` as const;
      const meta = await this.describeOrThrow(previousKeyId, "dataKeyKeyId", fieldLabel);
      if (meta.KeyMetadata.Enabled !== true) {
        throw kmsKeyNotFoundError({
          tenantId: "(boot)",
          kid: `aws-kms describe(${previousKeyId}) for ${fieldLabel}: disabled`,
        });
      }
      if (meta.KeyMetadata.KeyUsage !== "ENCRYPT_DECRYPT") {
        throw cryptoValidationError({
          field: fieldLabel,
          reason: `expected KeyUsage=ENCRYPT_DECRYPT, got ${formatField(meta.KeyMetadata.KeyUsage)} for ${previousKeyId}`,
        });
      }
      if (meta.KeyMetadata.KeySpec !== "SYMMETRIC_DEFAULT") {
        throw cryptoValidationError({
          field: fieldLabel,
          reason: `expected KeySpec=SYMMETRIC_DEFAULT, got ${formatField(meta.KeyMetadata.KeySpec)} for ${previousKeyId}`,
        });
      }
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

    const ciphertextBlob = new Uint8Array(input.wrappedDek);
    const encryptionContext = { tenantId: input.tenantId } as const;

    // Try the current CMK first. This is the steady-state path —
    // exactly one Decrypt call per unwrap when no rotation is in
    // flight. KMS validates that `KeyId` matches the CMK identity
    // baked into the ciphertext blob; the call fails with
    // InvalidCiphertextException if the envelope was wrapped under
    // a different CMK (the rotation case).
    //
    // KMS ALSO uses the EncryptionContext as additional authenticated
    // data on the wrap. Mismatched EncryptionContext returns the
    // same InvalidCiphertextException shape — but here that's a true
    // cross-tenant attempt that we WANT to fail closed (i.e. NOT
    // fall through to historical keys, because the historical keys
    // would reject it for the same reason). The fallthrough only
    // matters for the rotation case; the cross-tenant case still
    // surfaces as DECRYPT_FAILED, just via the historical-key path
    // when historical keys are configured.
    let lastError: unknown;
    let result: AwsKmsDecryptOutput | null = null;
    try {
      result = await this.client.decrypt({
        KeyId: this.dataKeyKeyId,
        CiphertextBlob: ciphertextBlob,
        EncryptionContext: encryptionContext,
      });
    } catch (cause) {
      lastError = cause;
    }

    // Fall through to historical CMKs if the current key did not
    // decrypt. Iterated in declared order — operators typically
    // place the most-recently-rotated CMK first, which is the most
    // likely match for in-flight envelopes during a bake-in window.
    //
    // We do NOT attempt to inspect the CiphertextBlob header to
    // guess which CMK wrapped it: the embedded key id is opaque to
    // application code (and exposing it via a "peek" call would
    // require AWS SDK internals). Burning at most
    // `previousDataKeyKeyIds.length + 1` round-trips per historical
    // envelope is acceptable for the rotation window — operators
    // drain the list as the metric below reports zero hits for the
    // tail entries.
    if (result === null) {
      for (let index = 0; index < this.previousDataKeyKeyIds.length; index += 1) {
        const historicalKeyId = this.previousDataKeyKeyIds[index]!;
        try {
          // Sequential by design: KMS Decrypt is the choke point,
          // and parallel fan-out would burn N×latency and N×IAM cost
          // on every historical envelope. Stop at the first success.
          result = await this.client.decrypt({
            KeyId: historicalKeyId,
            CiphertextBlob: ciphertextBlob,
            EncryptionContext: encryptionContext,
          });
          // 1-indexed position label so dashboards read naturally —
          // `key_position=1` is "the most recent historical key" in
          // the operator's mental model. Recorded only on SUCCESS so
          // a noisy cross-tenant attempt (every key rejects) does
          // not pollute the metric.
          kmsHistoricalKeyHitsCounter.add(1, { key_position: String(index + 1) });
          break;
        } catch (cause) {
          lastError = cause;
        }
      }
    }

    if (result === null) {
      // Every attempt failed. Surface the LAST error's message —
      // most informative for diagnosis (a current-key
      // InvalidCiphertextException is expected during rotation; the
      // tail error reveals whether the envelope is genuinely
      // unrecoverable or just bound to an unconfigured historical
      // CMK).
      //
      // KMS returns InvalidCiphertextException if EncryptionContext
      // doesn't match what was used at wrap time. That is the
      // cryptographic enforcement layer: even if the caller's
      // application-level tenancy check is bypassed, KMS will not
      // hand out the plaintext DEK. We convert it to our internal
      // error code so the caller experiences the same shape as the
      // local adapter.
      throw decryptFailedError({
        reason: lastError instanceof Error ? lastError.message : "kms.decrypt failed",
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
   * Audit-Merkle root signing is INTENTIONALLY NOT IMPLEMENTED on
   * this adapter. The responsibility lives on a different,
   * IAM-isolated port — `KmsAsymmetricSigner` in
   * `@pharmax/security` (ADR-0024).
   *
   * Why split the surface:
   *
   *   - Different IAM scope. `AwsKmsAdapter` holds
   *     `kms:GenerateDataKey` + `kms:Decrypt` + `kms:GenerateMac`
   *     on the PHI data + search keys. The signer holds ONLY
   *     `kms:Sign` + `kms:GetPublicKey` on the asymmetric audit
   *     key. Splitting the ports means the production task role
   *     for each app gets the minimal grant set — the print
   *     agent (read-only PHI) never gets near `kms:Sign`, and the
   *     audit-archive verifier never gets near `kms:Decrypt`.
   *
   *   - Different key class. Asymmetric SIGN_VERIFY keys are NOT
   *     supported by AWS automatic rotation and use a separate
   *     SDK surface (`SignCommand`, `GetPublicKeyCommand`). The
   *     two responsibilities have nothing in common at the SDK
   *     layer; collapsing them under one adapter would only obscure
   *     the IAM split.
   *
   *   - Different blast radius. A compromise of the PHI data-key
   *     IAM principal MUST NOT enable manifest forgery. Keeping
   *     `kms:Sign` off this adapter is the structural enforcement.
   *
   * Production paths use:
   *
   *   - `KmsAsymmetricSigner` (signing) — wired in the worker
   *     composition root by `createNightlyMerkleRootLoopFromEnv`
   *     and the `pnpm security:sign-merkle --prod` CLI.
   *   - `EcdsaP256SignatureVerifier` (verification) — offline,
   *     does not call KMS. Used by `pnpm security:verify-merkle`
   *     against the public-key PEM exported once per signing-key
   *     epoch (see RUNBOOK § "Rotating the Merkle signing key").
   *
   * The `LocalKmsAdapter` still implements `signRoot`/`verifyRoot`
   * (HMAC-SHA-256) because the local dev composition root binds
   * the local adapter to the worker's signer port — that path
   * stays self-contained and avoids requiring asymmetric crypto
   * in unit tests.
   *
   * If you reach this method in production, the composition root
   * is wired incorrectly — the worker should never call
   * `KmsAdapter.signRoot` on the AwsKmsAdapter; it should resolve
   * `KmsAsymmetricSigner` instead.
   */
  public async signRoot(input: SignRootInput): Promise<SignRootOutput> {
    throw kmsKeyNotFoundError({
      tenantId: input.tenantId,
      kid: "aws-kms.signRoot is not implemented by design; use KmsAsymmetricSigner from @pharmax/security (ADR-0024). Reaching this method indicates a miswired composition root.",
    });
  }

  public async verifyRoot(input: VerifyRootInput): Promise<boolean> {
    throw kmsKeyNotFoundError({
      tenantId: input.tenantId,
      kid: "aws-kms.verifyRoot is not implemented by design; use EcdsaP256SignatureVerifier from @pharmax/security (ADR-0024). Reaching this method indicates a miswired composition root.",
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
    field: "dataKeyKeyId" | "searchKeyKeyId",
    // Optional override for the field label in error messages —
    // historical CMKs share the `dataKeyKeyId` shape but produce
    // clearer diagnostics when the position in the array is named.
    fieldLabelOverride?: string
  ): Promise<AwsKmsDescribeKeyOutput> {
    const fieldLabel = fieldLabelOverride ?? field;
    try {
      return await this.client.describeKey({ KeyId: keyId });
    } catch (cause) {
      throw kmsKeyNotFoundError({
        tenantId: "(boot)",
        kid: `aws-kms describe(${keyId}) failed for ${fieldLabel}: ${
          cause instanceof Error ? cause.message : "unknown"
        }`,
      });
    }
  }
}

/**
 * Validate the `previousDataKeyKeyIds` option at construction time.
 *
 * Invariants:
 *   - Every entry is a non-empty string.
 *   - No entry equals `dataKeyKeyId` (silent duplicate would burn an
 *     extra Decrypt round-trip on every historical envelope for no
 *     gain — the current-key path already covers it).
 *   - No entry equals another entry (same reason, plus inflates the
 *     historical-key-hit metric incorrectly).
 *
 * Returns a frozen copy so the adapter cannot be mutated by a caller
 * holding a reference to the original array.
 */
function validatePreviousDataKeyKeyIds(
  raw: ReadonlyArray<string> | undefined,
  dataKeyKeyId: string
): ReadonlyArray<string> {
  if (raw === undefined) return Object.freeze([] as string[]);

  const seen = new Set<string>();
  seen.add(dataKeyKeyId);
  const cleaned: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (typeof entry !== "string" || entry.length === 0) {
      throw cryptoValidationError({
        field: `previousDataKeyKeyIds[${index}]`,
        reason: "must be a non-empty string",
      });
    }
    if (seen.has(entry)) {
      // Two surfaces here. Same entry twice = operator error. Entry
      // == current dataKeyKeyId = operator error (the current-key
      // attempt already covers it). Reject both up front so the
      // adapter cannot be in an unstable steady-state config.
      throw cryptoValidationError({
        field: `previousDataKeyKeyIds[${index}]`,
        reason:
          entry === dataKeyKeyId
            ? `duplicates dataKeyKeyId (${entry}); the current key is always tried first`
            : `duplicate entry (${entry})`,
      });
    }
    seen.add(entry);
    cleaned.push(entry);
  }
  return Object.freeze(cleaned);
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
