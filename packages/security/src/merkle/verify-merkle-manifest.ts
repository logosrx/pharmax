// Manifest verifier.
//
// Given:
//   - a `SignedMerkleManifest`, and
//   - a way to verify the signature (either a raw `KeyObject` for
//     Ed25519 or the equivalent KMS Verify port for production),
//   - a `ChainSource` to re-pull rows from the database,
//
// this module:
//   1. Re-derives the Merkle root from the current audit_log rows in
//      the manifest's [periodStart, periodEnd) window.
//   2. Compares the recomputed root against the manifest's
//      `rootHashHex`. Mismatch → tamper detected.
//   3. Verifies the signature over the canonical preimage built from
//      the (claimed) root + windowing context.
//   4. Returns a structured `VerifyManifestResult` so callers can
//      log/alert with actionable detail.
//
// The verifier NEVER throws on a verification failure — it returns
// `{ valid: false, reason }`. Throwing is reserved for caller-supplied
// argument errors (malformed manifest, missing source). This makes
// the verifier safe to use inside an audit-report aggregator that
// iterates many manifests and counts pass/fail without try/catch
// noise.

import { verify as cryptoVerify, type KeyObject } from "node:crypto";

import type { ChainSource } from "@pharmax/audit";

import { computeDailyMerkleRoot } from "./compute-daily-merkle-root.js";
import type { SignedMerkleManifest } from "./publish-merkle-manifest.js";
import { SIGNING_DOMAIN_TAG, buildSigningPreimage } from "./sign-merkle-root.js";

export type VerifyManifestResult =
  | { readonly valid: true; readonly leafCount: number }
  | {
      readonly valid: false;
      readonly reason: VerifyManifestFailureReason;
      readonly detail: string;
    };

export type VerifyManifestFailureReason =
  | "domain-tag-mismatch"
  | "merkle-root-mismatch"
  | "signature-invalid"
  | "signer-kid-untrusted"
  | "period-out-of-bounds"
  | "verifier-not-implemented";

export interface VerifierBounds {
  /** Earliest acceptable `periodStart` (inclusive). */
  readonly periodStartAfter?: Date;
  /** Latest acceptable `periodEnd` (inclusive). */
  readonly periodEndBefore?: Date;
}

export interface SignatureVerifier {
  /**
   * Verify that `signature` is a valid signature over `preimage` under
   * the signer identified by `signerKid`. Return true on success.
   */
  verify(args: {
    readonly preimage: Buffer;
    readonly signature: Buffer;
    readonly signerKid: string;
    readonly algorithm: SignedMerkleManifest["algorithm"];
  }): Promise<boolean>;
}

/**
 * Pre-baked verifier for `LocalEd25519Signer`. Construct one with the
 * exported PEM (e.g. from a fixture file) and pass it to
 * `verifyMerkleManifest`.
 */
export class LocalEd25519SignatureVerifier implements SignatureVerifier {
  private readonly publicKey: KeyObject;
  private readonly expectedSignerKid: string;

  constructor(args: { readonly publicKey: KeyObject; readonly signerKid: string }) {
    this.publicKey = args.publicKey;
    this.expectedSignerKid = args.signerKid;
  }

  public async verify(args: {
    readonly preimage: Buffer;
    readonly signature: Buffer;
    readonly signerKid: string;
    readonly algorithm: SignedMerkleManifest["algorithm"];
  }): Promise<boolean> {
    if (args.algorithm !== "ed25519") return false;
    if (args.signerKid !== this.expectedSignerKid) return false;
    return cryptoVerify(null, args.preimage, this.publicKey, args.signature);
  }
}

/**
 * Verifier for ECDSA P-256 (SHA-256) signatures produced by
 * `KmsAsymmetricSigner`. The verifier accepts the SPKI-PEM public
 * key returned by `signer.getPublicKeyPem()` (or fetched out-of-band
 * from `kms:GetPublicKey`); signature bytes are DER-encoded.
 *
 * Verification is offline — it does NOT call KMS. This matters for
 * the auditor workflow: they pin the public-key PEM in a fixture and
 * verify manifests against it without needing AWS credentials.
 */
export class EcdsaP256SignatureVerifier implements SignatureVerifier {
  private readonly publicKey: KeyObject;
  private readonly expectedSignerKid: string;

  constructor(args: { readonly publicKey: KeyObject; readonly signerKid: string }) {
    this.publicKey = args.publicKey;
    this.expectedSignerKid = args.signerKid;
  }

  public async verify(args: {
    readonly preimage: Buffer;
    readonly signature: Buffer;
    readonly signerKid: string;
    readonly algorithm: SignedMerkleManifest["algorithm"];
  }): Promise<boolean> {
    if (args.algorithm !== "ecdsa_sha_256") return false;
    if (args.signerKid !== this.expectedSignerKid) return false;
    return cryptoVerify("sha256", args.preimage, this.publicKey, args.signature);
  }
}

/**
 * Dispatcher that holds N trusted public keys keyed by `signerKid`
 * and verifies under whichever key the manifest names. Used by the
 * verify-from-S3 script so it can validate a historical run signed
 * under a rotated kid.
 */
export class MultiKidSignatureVerifier implements SignatureVerifier {
  private readonly byKid: Map<string, SignatureVerifier>;

  constructor(
    entries: ReadonlyArray<{ readonly signerKid: string; readonly verifier: SignatureVerifier }>
  ) {
    this.byKid = new Map(entries.map((e) => [e.signerKid, e.verifier]));
  }

  public async verify(args: {
    readonly preimage: Buffer;
    readonly signature: Buffer;
    readonly signerKid: string;
    readonly algorithm: SignedMerkleManifest["algorithm"];
  }): Promise<boolean> {
    const verifier = this.byKid.get(args.signerKid);
    if (verifier === undefined) return false;
    return verifier.verify(args);
  }

  public has(signerKid: string): boolean {
    return this.byKid.has(signerKid);
  }
}

export interface VerifyMerkleManifestInput {
  readonly manifest: SignedMerkleManifest;
  readonly source: ChainSource;
  readonly signatureVerifier: SignatureVerifier;
  /**
   * Optional allowlist of trusted `signerKid`s. When provided, the
   * verifier rejects manifests whose `signerKid` is not in the list
   * before re-deriving the root (cheap pre-flight check). Pass
   * `undefined` to skip this gate — the signature itself is still
   * authenticated.
   */
  readonly trustedSignerKids?: ReadonlyArray<string>;
  /**
   * Optional period bounds. Useful for an auditor verifying "all
   * manifests in Q2 2026"; manifests outside the window are flagged
   * `period-out-of-bounds` so the run produces a clean refusal
   * rather than silently accepting a misfiled manifest.
   */
  readonly bounds?: VerifierBounds;
}

export async function verifyMerkleManifest(
  input: VerifyMerkleManifestInput
): Promise<VerifyManifestResult> {
  if (input.manifest.signingDomainTag !== SIGNING_DOMAIN_TAG) {
    return {
      valid: false,
      reason: "domain-tag-mismatch",
      detail: `Manifest signing domain tag "${input.manifest.signingDomainTag}" does not match expected "${SIGNING_DOMAIN_TAG}".`,
    };
  }

  if (input.trustedSignerKids !== undefined && input.trustedSignerKids.length > 0) {
    if (!input.trustedSignerKids.includes(input.manifest.signerKid)) {
      return {
        valid: false,
        reason: "signer-kid-untrusted",
        detail: `Manifest signed by kid "${input.manifest.signerKid}", which is not in the trusted-kid set.`,
      };
    }
  }

  if (input.bounds !== undefined) {
    const periodStart = new Date(input.manifest.periodStart);
    const periodEnd = new Date(input.manifest.periodEnd);
    if (
      input.bounds.periodStartAfter !== undefined &&
      periodStart.getTime() < input.bounds.periodStartAfter.getTime()
    ) {
      return {
        valid: false,
        reason: "period-out-of-bounds",
        detail: `Manifest periodStart ${periodStart.toISOString()} is before required floor ${input.bounds.periodStartAfter.toISOString()}.`,
      };
    }
    if (
      input.bounds.periodEndBefore !== undefined &&
      periodEnd.getTime() > input.bounds.periodEndBefore.getTime()
    ) {
      return {
        valid: false,
        reason: "period-out-of-bounds",
        detail: `Manifest periodEnd ${periodEnd.toISOString()} is after required ceiling ${input.bounds.periodEndBefore.toISOString()}.`,
      };
    }
  }

  const recomputed = await computeDailyMerkleRoot({
    organizationId: input.manifest.organizationId,
    periodStart: new Date(input.manifest.periodStart),
    periodEnd: new Date(input.manifest.periodEnd),
    source: input.source,
  });

  const expectedRootHex = input.manifest.rootHashHex;
  const actualRootHex = recomputed.rootHash.toString("hex");
  if (expectedRootHex !== actualRootHex) {
    return {
      valid: false,
      reason: "merkle-root-mismatch",
      detail: `Recomputed Merkle root ${actualRootHex} does not match manifest ${expectedRootHex}.`,
    };
  }

  const preimage = buildSigningPreimage({
    rootHash: recomputed.rootHash,
    organizationId: input.manifest.organizationId,
    periodStart: new Date(input.manifest.periodStart),
    periodEnd: new Date(input.manifest.periodEnd),
  });

  const signature = Buffer.from(input.manifest.signatureBase64, "base64");
  const sigOk = await input.signatureVerifier.verify({
    preimage,
    signature,
    signerKid: input.manifest.signerKid,
    algorithm: input.manifest.algorithm,
  });

  if (!sigOk) {
    return {
      valid: false,
      reason: "signature-invalid",
      detail: `Signature did not verify under signer ${input.manifest.signerKid} with algorithm ${input.manifest.algorithm}.`,
    };
  }

  return { valid: true, leafCount: recomputed.leafCount };
}
