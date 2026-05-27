// Signer port + adapters for the daily Merkle root.
//
// The signer's job is to produce a detached signature over the Merkle
// root + binding context (organizationId, periodStart, periodEnd) so
// that an auditor can later verify the manifest without trusting the
// publisher. Two adapters are provided:
//
//   - `LocalEd25519Signer` — generates / accepts an Ed25519 keypair in
//     process memory. Suitable for tests, local dev, and the
//     bootstrapping path before KMS is wired. Keys are NEVER persisted
//     by this adapter; the caller decides whether to write the public
//     key to disk for verification fixtures.
//
//   - `KmsAsymmetricSigner` — production. Wraps AWS KMS asymmetric
//     `Sign` (SigningAlgorithm = `ECDSA_SHA_256`, KeySpec =
//     `ECC_NIST_P256`) with `KeyUsage = SIGN_VERIFY` and `GetPublicKey`
//     for offline verification. The application process holds ONLY
//     `kms:Sign` + `kms:GetPublicKey` permissions on this key — the
//     plaintext private key never leaves AWS KMS.
//
// Binding: signers MUST sign over the FULL `SigningInput` byte block
// (not just `rootHash`). Without the binding, an attacker who can swap
// manifests between organizations or between days would defeat the
// chain of custody.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { errors } from "@pharmax/platform-core";

import type { KmsAsymmetricSigningClient } from "./kms-signing-client.js";

/** Length-prefixed canonical concatenation of the signed fields. */
function canonicalSigningPreimage(input: SigningInput): Buffer {
  const parts: Buffer[] = [];

  function appendLengthPrefixed(value: Buffer): void {
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(value.length, 0);
    parts.push(lengthBuffer);
    parts.push(value);
  }

  appendLengthPrefixed(Buffer.from(SIGNING_DOMAIN_TAG, "utf8"));
  appendLengthPrefixed(input.rootHash);
  appendLengthPrefixed(Buffer.from(input.organizationId, "utf8"));
  appendLengthPrefixed(Buffer.from(input.periodStart.toISOString(), "utf8"));
  appendLengthPrefixed(Buffer.from(input.periodEnd.toISOString(), "utf8"));

  return Buffer.concat(parts);
}

/** Domain tag committed to the signing preimage. Bumping it is a key-rotation event. */
export const SIGNING_DOMAIN_TAG = "pharmax/audit-merkle/v1";

export interface SigningInput {
  readonly rootHash: Buffer;
  readonly organizationId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

export interface SigningOutput {
  readonly signature: Buffer;
  /** Key identifier of the signer. For KMS, the KMS Key ARN; for Ed25519, the SHA-256 of the public key. */
  readonly signerKid: string;
  readonly signedAt: Date;
  /** Stable algorithm identifier for downstream verification. */
  readonly algorithm: SigningAlgorithm;
}

export type SigningAlgorithm = "ed25519" | "ecdsa_sha_256" | "rsassa_pss_sha_256";

export interface MerkleRootSigner {
  sign(input: SigningInput): Promise<SigningOutput>;
  /** SignerKid the signer would produce; useful for manifest assembly without a sign call. */
  readonly signerKid: string;
  readonly algorithm: SigningAlgorithm;
}

export const SECURITY_SIGNER_UNAVAILABLE = "SECURITY_SIGNER_UNAVAILABLE" as const;
export const MERKLE_SIGN_FAILED = "MERKLE_SIGN_FAILED" as const;
export const MERKLE_PUBLIC_KEY_FETCH_FAILED = "MERKLE_PUBLIC_KEY_FETCH_FAILED" as const;

export interface LocalEd25519SignerOptions {
  readonly privateKey?: KeyObject;
  readonly publicKey?: KeyObject;
  /** Optional deterministic seed for the keypair. Strictly for tests. */
  readonly seed?: Buffer;
  /** Override the clock; defaults to `Date.now`. */
  readonly clock?: () => Date;
}

export interface LocalEd25519SignerPublicMaterial {
  readonly publicKeyPem: string;
  readonly signerKid: string;
  readonly algorithm: "ed25519";
}

/**
 * In-process Ed25519 signer used by tests and dev scripts. Production
 * SHOULD use `KmsAsymmetricSigner` once the asymmetric KMS key is
 * provisioned (Lane 2 Terraform).
 */
export class LocalEd25519Signer implements MerkleRootSigner {
  public readonly algorithm = "ed25519" as const;
  public readonly signerKid: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly clock: () => Date;

  constructor(options: LocalEd25519SignerOptions = {}) {
    if (options.privateKey !== undefined && options.publicKey !== undefined) {
      this.privateKey = options.privateKey;
      this.publicKey = options.publicKey;
    } else if (options.seed !== undefined) {
      // Build a deterministic Ed25519 key from a 32-byte seed via the
      // PKCS#8 wire format. This is ONLY safe for tests; production
      // keys are managed by KMS.
      if (options.seed.length !== 32) {
        throw new TypeError("LocalEd25519Signer: seed must be 32 bytes.");
      }
      const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
      const pkcs8 = Buffer.concat([pkcs8Prefix, options.seed]);
      this.privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const generated = generateKeyPairSync("ed25519");
      this.privateKey = generated.privateKey;
      this.publicKey = generated.publicKey;
    }
    this.clock = options.clock ?? (() => new Date());
    this.signerKid = LocalEd25519Signer.computeKidFromPublicKey(this.publicKey);
  }

  public async sign(input: SigningInput): Promise<SigningOutput> {
    const preimage = canonicalSigningPreimage(input);
    // Ed25519 in Node accepts a Buffer directly to `sign(null, msg, key)`.
    const signature = sign(null, preimage, this.privateKey);
    return {
      signature,
      signerKid: this.signerKid,
      signedAt: this.clock(),
      algorithm: this.algorithm,
    };
  }

  public exportPublicMaterial(): LocalEd25519SignerPublicMaterial {
    return {
      publicKeyPem: this.publicKey.export({ type: "spki", format: "pem" }).toString(),
      signerKid: this.signerKid,
      algorithm: this.algorithm,
    };
  }

  public static computeKidFromPublicKey(publicKey: KeyObject): string {
    const spkiDer = publicKey.export({ type: "spki", format: "der" });
    const hash = createHash("sha256");
    hash.update(spkiDer);
    return `ed25519:${hash.digest("hex")}`;
  }
}

export interface KmsAsymmetricSignerOptions {
  /**
   * Lane 2 Terraform output: `module.audit_signing.kms_key_arn`. This
   * is the ARN of an AWS KMS asymmetric key with KeySpec =
   * `ECC_NIST_P256` and KeyUsage = `SIGN_VERIFY`. The application
   * process IAM role MUST be granted `kms:Sign` + `kms:GetPublicKey`
   * on this ARN only — no other identity should hold `kms:Sign` on
   * this key.
   */
  readonly keyArn: string;
  /** Injected AWS KMS port. Production: a wrapper around `@aws-sdk/client-kms` `KMSClient`. Tests: a fake. */
  readonly kmsClient: KmsAsymmetricSigningClient;
  /** Override the wall clock. Defaults to `() => new Date()`. */
  readonly clock?: () => Date;
}

/**
 * Stable prefix for the production signer kid. Bumping the trailing
 * `v1` is a key-rotation event — manifests still carry the old kid
 * and remain verifiable because each manifest pins its own
 * `signerKid`, but new manifests start signing under the next-version
 * kid for forward-going CloudTrail attribution.
 */
const KMS_ASYMM_SIGNER_KID_VERSION = "v1" as const;

/**
 * Build the stable signerKid for an AWS KMS asymmetric key + version
 * pair. The `aws:kms:asymm:` prefix is what the verifier dispatches
 * on; the trailing `:vN` is incremented on key rotation so manifests
 * are unambiguous about which signing identity produced them.
 *
 * Exposed so the verify-side dispatcher and the rotation script can
 * compare without re-implementing the format.
 */
export function buildKmsAsymmetricSignerKid(
  keyArn: string,
  version: string = KMS_ASYMM_SIGNER_KID_VERSION
): string {
  if (typeof keyArn !== "string" || keyArn.length === 0) {
    throw new TypeError("buildKmsAsymmetricSignerKid: keyArn must be a non-empty string.");
  }
  return `aws:kms:asymm:${keyArn}:${version}`;
}

/**
 * Production signer backed by AWS KMS asymmetric keys.
 *
 * Crypto invariants:
 *
 *   - KeySpec MUST be `ECC_NIST_P256` and KeyUsage MUST be
 *     `SIGN_VERIFY`. The constructor accepts a `keyArn` only; the
 *     adapter VERIFIES the key spec on first use via `GetPublicKey`
 *     and rejects keys that do not match. This catches the
 *     misconfigured-Terraform foot-gun where the asymm-sign key
 *     accidentally lands as `RSA_2048` or `SYMMETRIC_DEFAULT`.
 *
 *   - `SigningAlgorithm` is `ECDSA_SHA_256` (deterministic per AWS
 *     KMS contract for ECC NIST keys). The signature returned is
 *     DER-encoded — the verifier MUST treat it as DER, not raw r||s.
 *
 *   - The preimage is the SAME `canonicalSigningPreimage()` bytes
 *     the LocalEd25519 path uses. We sign `MessageType = "RAW"` so
 *     KMS computes SHA-256 over our preimage internally — feeding
 *     the digest with `MessageType = "DIGEST"` would let an attacker
 *     who can choose the preimage compute a colliding root and reuse
 *     a historical signature.
 *
 * Operational invariants:
 *
 *   - The public key is cached on the instance after the first
 *     `GetPublicKey` call. Asymm KMS keys do NOT rotate in-place
 *     (rotation is a NEW key ARN); a cached PEM is safe for the
 *     process lifetime. Cross-process verification re-fetches.
 *
 *   - `signerKid` is `aws:kms:asymm:<keyArn>:v1`. The format is
 *     stable; a future rotation event would land under `:v2` and the
 *     verifier accepts any historically-trusted kid via its
 *     dispatcher.
 *
 *   - Any KMS SDK error is mapped to `MERKLE_SIGN_FAILED` /
 *     `MERKLE_PUBLIC_KEY_FETCH_FAILED` with the underlying error
 *     name in metadata, so the loop's structured-error tally can
 *     classify failures.
 */
export class KmsAsymmetricSigner implements MerkleRootSigner {
  public readonly algorithm = "ecdsa_sha_256" as const;
  public readonly signerKid: string;
  public readonly keyArn: string;

  private readonly kmsClient: KmsAsymmetricSigningClient;
  private readonly clock: () => Date;
  private cachedPublicKeyPem: string | null = null;
  private cachedResolvedKeyArn: string | null = null;
  private publicKeyFetchInFlight: Promise<string> | null = null;

  constructor(options: KmsAsymmetricSignerOptions) {
    if (typeof options.keyArn !== "string" || options.keyArn.length === 0) {
      throw new TypeError("KmsAsymmetricSigner: keyArn is required.");
    }
    this.keyArn = options.keyArn;
    this.signerKid = buildKmsAsymmetricSignerKid(options.keyArn);
    this.kmsClient = options.kmsClient;
    this.clock = options.clock ?? (() => new Date());
  }

  public async sign(input: SigningInput): Promise<SigningOutput> {
    const preimage = canonicalSigningPreimage(input);
    let signatureBytes: Uint8Array;
    try {
      const out = await this.kmsClient.sign({
        KeyId: this.keyArn,
        Message: preimage,
        // RAW (not DIGEST): we hand KMS the FULL canonical preimage
        // and let KMS compute the SHA-256 over it. Signing the digest
        // directly with MessageType=DIGEST would erase the binding
        // between the signature and OUR canonical preimage format.
        MessageType: "RAW",
        SigningAlgorithm: "ECDSA_SHA_256",
      });
      if (out.Signature === undefined) {
        throw new errors.InternalError({
          code: MERKLE_SIGN_FAILED,
          message: "AWS KMS Sign returned no Signature bytes.",
          metadata: { keyArn: this.keyArn },
        });
      }
      signatureBytes = out.Signature;
    } catch (cause) {
      if (cause instanceof errors.InternalError) throw cause;
      const name = cause instanceof Error ? cause.name : "unknown";
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new errors.InternalError({
        code: MERKLE_SIGN_FAILED,
        message: `AWS KMS Sign failed: ${name}: ${message}`,
        metadata: { keyArn: this.keyArn, awsErrorName: name },
        cause,
      });
    }

    return {
      signature: Buffer.from(signatureBytes),
      signerKid: this.signerKid,
      signedAt: this.clock(),
      algorithm: this.algorithm,
    };
  }

  /**
   * Returns the SPKI-encoded PEM public key for this signer's KMS
   * key. Cached after the first call — KMS asymm keys do NOT rotate
   * in-place, so a process-lifetime cache is safe.
   *
   * The first call also validates `KeySpec === "ECC_NIST_P256"` and
   * `KeyUsage === "SIGN_VERIFY"` and throws if the operator pointed
   * the signer at the wrong KMS key. This is a load-bearing safety
   * check: an RSA or symmetric key would silently produce signatures
   * the verifier cannot use, and the failure would only surface
   * during an audit.
   */
  public async getPublicKeyPem(): Promise<string> {
    if (this.cachedPublicKeyPem !== null) return this.cachedPublicKeyPem;
    // Coalesce concurrent fetches — the loop iterates orgs serially
    // today but a future parallel layout MUST NOT issue N
    // GetPublicKey calls per signer.
    if (this.publicKeyFetchInFlight !== null) return this.publicKeyFetchInFlight;
    this.publicKeyFetchInFlight = this.fetchAndValidatePublicKey().finally(() => {
      this.publicKeyFetchInFlight = null;
    });
    return this.publicKeyFetchInFlight;
  }

  /**
   * Returns the resolved KMS key ARN as reported by `GetPublicKey`.
   * Useful for verifier tests pinning that the ARN we configured
   * with matches what AWS resolved (e.g. an alias resolving to an
   * underlying key ARN).
   */
  public async getResolvedKeyArn(): Promise<string> {
    await this.getPublicKeyPem();
    if (this.cachedResolvedKeyArn === null) {
      throw new errors.InternalError({
        code: MERKLE_PUBLIC_KEY_FETCH_FAILED,
        message: "KmsAsymmetricSigner: resolved key ARN is not available.",
        metadata: { keyArn: this.keyArn },
      });
    }
    return this.cachedResolvedKeyArn;
  }

  private async fetchAndValidatePublicKey(): Promise<string> {
    let resp: Awaited<ReturnType<KmsAsymmetricSigningClient["getPublicKey"]>>;
    try {
      resp = await this.kmsClient.getPublicKey({ KeyId: this.keyArn });
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : "unknown";
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new errors.InternalError({
        code: MERKLE_PUBLIC_KEY_FETCH_FAILED,
        message: `AWS KMS GetPublicKey failed: ${name}: ${message}`,
        metadata: { keyArn: this.keyArn, awsErrorName: name },
        cause,
      });
    }
    if (resp.PublicKey === undefined) {
      throw new errors.InternalError({
        code: MERKLE_PUBLIC_KEY_FETCH_FAILED,
        message: "AWS KMS GetPublicKey returned no PublicKey bytes.",
        metadata: { keyArn: this.keyArn },
      });
    }
    if (resp.KeySpec !== undefined && resp.KeySpec !== "ECC_NIST_P256") {
      throw new errors.InternalError({
        code: MERKLE_PUBLIC_KEY_FETCH_FAILED,
        message: `KMS key ${this.keyArn} has KeySpec=${resp.KeySpec}; KmsAsymmetricSigner requires ECC_NIST_P256.`,
        metadata: { keyArn: this.keyArn, keySpec: resp.KeySpec },
      });
    }
    if (resp.KeyUsage !== undefined && resp.KeyUsage !== "SIGN_VERIFY") {
      throw new errors.InternalError({
        code: MERKLE_PUBLIC_KEY_FETCH_FAILED,
        message: `KMS key ${this.keyArn} has KeyUsage=${resp.KeyUsage}; KmsAsymmetricSigner requires SIGN_VERIFY.`,
        metadata: { keyArn: this.keyArn, keyUsage: resp.KeyUsage },
      });
    }
    const der = Buffer.from(resp.PublicKey);
    const base64 = der.toString("base64");
    const wrapped = base64.replace(/(.{64})/g, "$1\n");
    const pem = `-----BEGIN PUBLIC KEY-----\n${wrapped}${wrapped.endsWith("\n") ? "" : "\n"}-----END PUBLIC KEY-----\n`;
    this.cachedPublicKeyPem = pem;
    this.cachedResolvedKeyArn = resp.KeyId ?? this.keyArn;
    return pem;
  }
}

/** Exposed for verifier tests so they can re-derive the byte block. */
export function buildSigningPreimage(input: SigningInput): Buffer {
  return canonicalSigningPreimage(input);
}
