// Manifest publisher port + adapters.
//
// A "manifest" is the JSON document that bundles:
//
//   - The Merkle root + windowing metadata (org, period, leaf count,
//     first/last seq).
//   - The signature + signer kid + algorithm.
//   - A schema/version tag so future schema changes are detectable.
//
// The publisher writes the manifest to durable, append-only storage.
// Two adapters are provided:
//
//   - `InMemoryManifestPublisher` — test/dev. Keeps a map keyed by
//     manifest URI; verifier tests can pull the manifest back out
//     without S3.
//
//   - `S3ObjectLockPublisher` — production. PUTs the manifest to an
//     S3 bucket provisioned (via Lane 2 Terraform) with Object Lock
//     in COMPLIANCE mode + a default retention matching the SOC 2
//     retention policy. The publisher refuses to overwrite via a
//     pre-PUT `HeadObject` AND the conditional `IfNoneMatch: *`, and
//     pins encryption to a customer-managed KMS key.
//
// COMPLIANCE-mode Object Lock is a *one-way ratchet*: once an object
// is written under a retention window, NO IAM principal (including
// the root account) can delete or overwrite it before the window
// expires. This is by design — the property is exactly what makes
// the published manifest evidence — but it means the publisher MUST
// be explicit about retention. We never call `PutObject` without a
// retention date; we never accept a retention period under 1 day.

import { createHash } from "node:crypto";

import { errors } from "@pharmax/platform-core";

import type { S3ObjectLockClient } from "./s3-object-lock-client.js";
import type { SigningAlgorithm } from "./sign-merkle-root.js";

export const MANIFEST_SCHEMA_VERSION = 1 as const;

export const SECURITY_MANIFEST_PUBLISH_FAILED = "SECURITY_MANIFEST_PUBLISH_FAILED" as const;
export const MERKLE_PUBLISH_FAILED = "MERKLE_PUBLISH_FAILED" as const;
export const MERKLE_MANIFEST_OVERWRITE_REFUSED = "MERKLE_MANIFEST_OVERWRITE_REFUSED" as const;

/** Lower bound on Object Lock retention. Anything less is operator error. */
export const MIN_RETENTION_DAYS = 1 as const;

/** Body of a signed Merkle manifest. Stable JSON shape — bump `schemaVersion` for breaking changes. */
export interface SignedMerkleManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly organizationId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly computedAt: string;
  readonly signedAt: string;
  readonly leafCount: number;
  readonly firstSeq: string | null;
  readonly lastSeq: string | null;
  readonly rootHashHex: string;
  readonly signatureBase64: string;
  readonly signerKid: string;
  readonly algorithm: SigningAlgorithm;
  /** Domain tag committed to the signature preimage. */
  readonly signingDomainTag: string;
}

export interface PublishManifestOutput {
  readonly uri: string;
  readonly publishedAt: Date;
  /** S3 ETag, when the publisher actually wrote (vs. observed an existing manifest). */
  readonly eTag?: string;
  /** S3 versionId for versioned buckets. */
  readonly versionId?: string;
  /** Effective Object Lock retain-until date the publisher set on the object. */
  readonly retainUntilDate?: Date;
  /** True when the publisher observed an existing manifest and did not write a new one. */
  readonly idempotent?: boolean;
}

export interface ManifestPublisher {
  publish(manifest: SignedMerkleManifest): Promise<PublishManifestOutput>;
  /** Optional: fetch a previously-published manifest for verification. */
  fetch?(uri: string): Promise<SignedMerkleManifest | null>;
}

/**
 * Construct the canonical manifest URI for an organization+date. The
 * URI is the value returned by `publish()` — the InMemory publisher
 * uses it as its key, and the S3 publisher uses it as the object key
 * under the audit-archive bucket.
 */
export function manifestObjectKey(input: {
  readonly organizationId: string;
  readonly periodStart: Date;
}): string {
  const yyyy = input.periodStart.getUTCFullYear().toString().padStart(4, "0");
  const mm = (input.periodStart.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = input.periodStart.getUTCDate().toString().padStart(2, "0");
  return `${input.organizationId}/${yyyy}/${mm}/${dd}/merkle-manifest.json`;
}

export class InMemoryManifestPublisher implements ManifestPublisher {
  private readonly store: Map<string, SignedMerkleManifest> = new Map();
  private readonly clock: () => Date;
  private readonly uriPrefix: string;

  constructor(options?: { readonly clock?: () => Date; readonly uriPrefix?: string }) {
    this.clock = options?.clock ?? (() => new Date());
    this.uriPrefix = options?.uriPrefix ?? "memory://audit-archive/";
  }

  public async publish(manifest: SignedMerkleManifest): Promise<PublishManifestOutput> {
    const key = manifestObjectKey({
      organizationId: manifest.organizationId,
      periodStart: new Date(manifest.periodStart),
    });
    const uri = `${this.uriPrefix}${key}`;
    if (this.store.has(uri)) {
      throw new errors.InternalError({
        code: SECURITY_MANIFEST_PUBLISH_FAILED,
        message: `Manifest already exists at ${uri} (refusing to overwrite).`,
        metadata: { uri },
      });
    }
    this.store.set(uri, manifest);
    return { uri, publishedAt: this.clock() };
  }

  public async fetch(uri: string): Promise<SignedMerkleManifest | null> {
    return this.store.get(uri) ?? null;
  }

  /** Test helper: enumerate published manifests. */
  public list(): ReadonlyArray<{ readonly uri: string; readonly manifest: SignedMerkleManifest }> {
    return Array.from(this.store, ([uri, manifest]) => ({ uri, manifest }));
  }
}

export interface S3ObjectLockPublisherOptions {
  /** Lane 2 Terraform output: `module.audit_archive.bucket_name`. */
  readonly bucket: string;
  /** Region of the bucket. Informational — used only for the returned URI. */
  readonly region: string;
  /**
   * Retention duration in days. COMPLIANCE-mode Object Lock will
   * refuse delete/overwrite for this many days starting from publish
   * time. Default 7y aligns with HIPAA `§164.316(b)(2)` retention.
   */
  readonly retentionDays: number;
  /** Customer-managed KMS key id (or ARN) for SSE-KMS on the manifest object. */
  readonly kmsKeyId: string;
  /** Injected AWS S3 port. Production: real client. Tests: fake. */
  readonly s3Client: S3ObjectLockClient;
  /** Override the wall clock. Defaults to `() => new Date()`. */
  readonly clock?: () => Date;
}

/**
 * Production publisher.
 *
 * Crypto / compliance invariants:
 *
 *   - The object is encrypted at rest with SSE-KMS using a customer-
 *     managed key. Refusing to fall back to SSE-S3 keeps the
 *     CloudTrail key-usage history a complete custody record.
 *
 *   - `ObjectLockMode = "COMPLIANCE"`: once written, the object
 *     CANNOT be deleted or overwritten — not by any IAM principal,
 *     not by the root account — until `ObjectLockRetainUntilDate`
 *     passes. This is the load-bearing property; GOVERNANCE-mode
 *     would let a privileged actor bypass retention with
 *     `s3:BypassGovernanceRetention`, which defeats the threat
 *     model in ADR-0024.
 *
 *   - `IfNoneMatch: "*"`: S3's conditional-write contract rejects
 *     the PUT (412 PreconditionFailed) when an object exists at the
 *     key. We use it BELT-AND-BRACES with a `HeadObject` pre-check
 *     so the operator-facing error message clearly says "manifest
 *     already exists" instead of leaking an opaque 412 from the
 *     SDK. Object Lock COMPLIANCE would also reject the overwrite,
 *     so this is defense in depth.
 *
 *   - Idempotency: a re-run of the same day for the same org finds
 *     the existing manifest (HeadObject succeeds) and returns its
 *     metadata WITHOUT a second PutObject. This makes the script in
 *     `scripts/security/sign-daily-merkle-root.ts` safe to retry.
 */
export class S3ObjectLockPublisher implements ManifestPublisher {
  private readonly options: S3ObjectLockPublisherOptions;
  private readonly clock: () => Date;

  constructor(options: S3ObjectLockPublisherOptions) {
    if (typeof options.bucket !== "string" || options.bucket.length === 0) {
      throw new TypeError("S3ObjectLockPublisher: bucket is required.");
    }
    if (typeof options.kmsKeyId !== "string" || options.kmsKeyId.length === 0) {
      throw new TypeError("S3ObjectLockPublisher: kmsKeyId is required.");
    }
    if (!Number.isInteger(options.retentionDays) || options.retentionDays < MIN_RETENTION_DAYS) {
      throw new RangeError(
        `S3ObjectLockPublisher: retentionDays must be an integer >= ${MIN_RETENTION_DAYS} (got ${String(options.retentionDays)}). COMPLIANCE Object Lock is a one-way ratchet; refusing to publish with a too-short window.`
      );
    }
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
  }

  public async publish(manifest: SignedMerkleManifest): Promise<PublishManifestOutput> {
    const key = manifestObjectKey({
      organizationId: manifest.organizationId,
      periodStart: new Date(manifest.periodStart),
    });
    const uri = `s3://${this.options.bucket}/${key}`;

    let existing: Awaited<ReturnType<S3ObjectLockClient["headObject"]>> | null = null;
    try {
      existing = await this.options.s3Client.headObject({
        Bucket: this.options.bucket,
        Key: key,
      });
    } catch (cause) {
      throw publishFailedError({
        uri,
        bucket: this.options.bucket,
        cause,
        operation: "HeadObject",
      });
    }
    if (existing !== null) {
      // Idempotent: a second publish of the SAME manifest content for
      // the SAME org+day is treated as success. We do NOT re-PUT —
      // Object Lock COMPLIANCE would reject it anyway, and the
      // operator just wants to know the manifest is on the bucket.
      return {
        uri,
        publishedAt: existing.LastModified ?? this.clock(),
        ...(existing.ETag !== undefined ? { eTag: existing.ETag } : {}),
        ...(existing.VersionId !== undefined ? { versionId: existing.VersionId } : {}),
        idempotent: true,
      };
    }

    const body = Buffer.from(JSON.stringify(manifest), "utf8");
    const checksumBase64 = createHash("sha256").update(body).digest("base64");
    const retainUntil = new Date(this.clock().getTime() + this.options.retentionDays * 86_400_000);
    let putResult: Awaited<ReturnType<S3ObjectLockClient["putObject"]>>;
    try {
      putResult = await this.options.s3Client.putObject({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        ContentLength: body.length,
        ChecksumSHA256: checksumBase64,
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: this.options.kmsKeyId,
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: retainUntil,
        ObjectLockLegalHoldStatus: "OFF",
        IfNoneMatch: "*",
        Metadata: {
          "pharmax-org": manifest.organizationId,
          "pharmax-period-start": manifest.periodStart,
          "pharmax-period-end": manifest.periodEnd,
          "pharmax-schema-version": String(manifest.schemaVersion),
          "pharmax-signer-kid": manifest.signerKid,
        },
      });
    } catch (cause) {
      // S3 returns PreconditionFailed (412) when IfNoneMatch fires
      // against an existing key. Treat it as the idempotent-refuse
      // case so the operator gets a clean code, not a raw 412.
      if (isAwsPreconditionFailed(cause)) {
        throw new errors.ConflictError({
          code: MERKLE_MANIFEST_OVERWRITE_REFUSED,
          message: `Manifest already exists at ${uri}; refused to overwrite (Object Lock COMPLIANCE).`,
          metadata: { uri, bucket: this.options.bucket, key },
          cause,
        });
      }
      throw publishFailedError({
        uri,
        bucket: this.options.bucket,
        cause,
        operation: "PutObject",
      });
    }

    return {
      uri,
      publishedAt: this.clock(),
      ...(putResult.ETag !== undefined ? { eTag: putResult.ETag } : {}),
      ...(putResult.VersionId !== undefined ? { versionId: putResult.VersionId } : {}),
      retainUntilDate: retainUntil,
      idempotent: false,
    };
  }

  /**
   * Fetch a previously-published manifest for verification. Returns
   * `null` if the object is not present. Throws on transient AWS
   * errors so the verifier surfaces them rather than silently
   * mis-reporting "no manifest".
   */
  public async fetch(uri: string): Promise<SignedMerkleManifest | null> {
    const prefix = `s3://${this.options.bucket}/`;
    if (!uri.startsWith(prefix)) {
      throw new errors.ValidationError({
        code: MERKLE_PUBLISH_FAILED,
        message: `S3ObjectLockPublisher.fetch: uri "${uri}" does not match bucket "${this.options.bucket}".`,
        issues: [{ path: ["uri"], message: "bucket mismatch" }],
      });
    }
    const key = uri.slice(prefix.length);
    const got = await this.options.s3Client.getObject({
      Bucket: this.options.bucket,
      Key: key,
    });
    if (got === null) return null;
    return JSON.parse(got.Body.toString("utf8")) as SignedMerkleManifest;
  }
}

function publishFailedError(detail: {
  readonly uri: string;
  readonly bucket: string;
  readonly cause: unknown;
  readonly operation: "PutObject" | "HeadObject";
}): errors.InternalError {
  const name = detail.cause instanceof Error ? detail.cause.name : "unknown";
  const message = detail.cause instanceof Error ? detail.cause.message : String(detail.cause);
  return new errors.InternalError({
    code: MERKLE_PUBLISH_FAILED,
    message: `S3 ${detail.operation} failed: ${name}: ${message}`,
    metadata: {
      uri: detail.uri,
      bucket: detail.bucket,
      awsErrorName: name,
      operation: detail.operation,
    },
    cause: detail.cause,
  });
}

function isAwsPreconditionFailed(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const name = (cause as { name?: unknown }).name;
  if (name === "PreconditionFailed") return true;
  const statusCode = (cause as { $metadata?: { httpStatusCode?: unknown } }).$metadata
    ?.httpStatusCode;
  return statusCode === 412;
}

/**
 * Build the immutable JSON body. Centralized so verifier tests use
 * the same serialization the publisher will write.
 */
export function buildSignedMerkleManifest(input: {
  readonly organizationId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly computedAt: Date;
  readonly signedAt: Date;
  readonly leafCount: number;
  readonly firstSeq: bigint | null;
  readonly lastSeq: bigint | null;
  readonly rootHash: Buffer;
  readonly signature: Buffer;
  readonly signerKid: string;
  readonly algorithm: SigningAlgorithm;
  readonly signingDomainTag: string;
}): SignedMerkleManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    organizationId: input.organizationId,
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    computedAt: input.computedAt.toISOString(),
    signedAt: input.signedAt.toISOString(),
    leafCount: input.leafCount,
    firstSeq: input.firstSeq === null ? null : input.firstSeq.toString(),
    lastSeq: input.lastSeq === null ? null : input.lastSeq.toString(),
    rootHashHex: input.rootHash.toString("hex"),
    signatureBase64: input.signature.toString("base64"),
    signerKid: input.signerKid,
    algorithm: input.algorithm,
    signingDomainTag: input.signingDomainTag,
  };
}
