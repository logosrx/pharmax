// Production evidence publisher: S3 + Object Lock COMPLIANCE.
//
// This is the adapter `evidence-publisher.ts` describes but did not
// ship. Until it landed, the quarterly access-review pack — the
// artifact an auditor asks for by name under SOC 2 CC6.2 — was written
// by `FilesystemEvidencePublisher` to an ECS container's ephemeral
// filesystem, and was gone at the next deployment.
//
// It writes to the SAME bucket as the Merkle manifests
// (`infra/terraform/modules/s3-audit-archive`), under a disjoint
// `access-reviews/` key prefix. That bucket is Object Lock COMPLIANCE
// with a default retention of `retention_years`.
//
// ---------------------------------------------------------------
// Why this publisher sends NO Object Lock headers
// ---------------------------------------------------------------
//
// A PUT that omits `x-amz-object-lock-mode` and
// `x-amz-object-lock-retain-until-date` inherits the bucket's default
// retention rule — COMPLIANCE for the configured term. A PUT that sends
// them OVERRIDES that default, and per-object GOVERNANCE retention can
// be lifted by any principal holding `s3:BypassGovernanceRetention`.
//
// So the strongest thing this publisher can do is say nothing and let
// the bucket decide. That is enforced structurally rather than by
// convention: `S3EvidenceObjectStore` below has no Object Lock fields
// at all, so this publisher *cannot* express a weaker retention even
// by mistake. The bucket policy's `DenyNonComplianceObjectLockMode`
// statement is the second line — and its `StringNotEqualsIfExists`
// operator is precisely what keeps this header-less PUT allowed while
// refusing a GOVERNANCE one.
//
// ---------------------------------------------------------------
// PHI
// ---------------------------------------------------------------
//
// Evidence packs are operator-access metadata: workforce identity,
// role assignments, per-actor command/audit COUNTS. They carry no
// patient identifiers and no clinical content. This matters more here
// than elsewhere because COMPLIANCE-mode Object Lock is a one-way
// ratchet — an object written under retention cannot be deleted by any
// principal, including the account root, until the term expires. A PHI
// leak into this bucket is unfixable by construction, so the PHI-free
// property of the pack is a precondition of using it, not a nicety.
//
// Note that `@pharmax/notifications`' PHI sentinel is deliberately NOT
// reused as a gate here: it treats any `email*` key as PHI, which is
// correct for a patient-facing notification payload and wrong for an
// access review, whose entire subject is which workforce email holds
// which role.

import { createHash } from "node:crypto";

import { errors } from "@pharmax/platform-core";

import type {
  EvidenceArtifact,
  EvidencePublishResult,
  EvidencePublisher,
} from "./evidence-publisher.js";

export const EVIDENCE_PUBLISH_FAILED = "EVIDENCE_PUBLISH_FAILED" as const;
export const EVIDENCE_OVERWRITE_REFUSED = "EVIDENCE_OVERWRITE_REFUSED" as const;

/**
 * PUT surface for evidence objects.
 *
 * Deliberately carries NO `ObjectLockMode` / `ObjectLockRetainUntilDate`
 * field. Adding one would let a caller weaken the bucket default; its
 * absence makes that unrepresentable. Retention is the bucket's
 * decision, and the bucket is Terraform's.
 */
export interface S3EvidencePutObjectInput {
  readonly Bucket: string;
  readonly Key: string;
  readonly Body: Buffer;
  readonly ContentType: string;
  readonly ContentLength: number;
  /** Base64 SHA-256, so S3 rejects a body corrupted in flight. */
  readonly ChecksumSHA256: string;
  readonly ServerSideEncryption: "aws:kms";
  readonly SSEKMSKeyId: string;
  /** Conditional write: 412 rather than an overwrite attempt. */
  readonly IfNoneMatch?: "*";
  readonly Metadata?: Record<string, string>;
}

export interface S3EvidencePutObjectOutput {
  readonly ETag?: string;
  readonly VersionId?: string;
}

export interface S3EvidenceHeadObjectOutput {
  readonly ETag?: string;
  readonly VersionId?: string;
  readonly ContentLength?: number;
  readonly LastModified?: Date;
}

/** Narrow port over `@aws-sdk/client-s3`; tests inject a fake. */
export interface S3EvidenceObjectStore {
  putObject(input: S3EvidencePutObjectInput): Promise<S3EvidencePutObjectOutput>;
  headObject(input: {
    readonly Bucket: string;
    readonly Key: string;
  }): Promise<S3EvidenceHeadObjectOutput | null>;
}

export interface S3ObjectLockEvidencePublisherOptions {
  /** Terraform output `module.s3_audit_archive.bucket_name`. */
  readonly bucket: string;
  /** Region of the bucket. Informational — used for the returned URI. */
  readonly region: string;
  /** Customer-managed CMK for SSE-KMS. The bucket policy pins this key. */
  readonly kmsKeyId: string;
  readonly s3: S3EvidenceObjectStore;
}

/**
 * Writes an evidence artifact once, and refuses to write it twice.
 *
 * Refusing the overwrite is the intended behaviour, not a limitation:
 * a re-run for a quarter that already has a pack must not silently
 * replace the evidence an auditor may already have been shown. Object
 * Lock would reject the overwrite anyway; the `HeadObject` pre-check
 * plus `IfNoneMatch` turn that into a named error instead of an opaque
 * AWS failure, and the operator decides whether to publish under a
 * `-rerun` suffix.
 */
export class S3ObjectLockEvidencePublisher implements EvidencePublisher {
  private readonly options: S3ObjectLockEvidencePublisherOptions;

  constructor(options: S3ObjectLockEvidencePublisherOptions) {
    if (typeof options.bucket !== "string" || options.bucket.length === 0) {
      throw new TypeError("S3ObjectLockEvidencePublisher: bucket is required.");
    }
    if (typeof options.kmsKeyId !== "string" || options.kmsKeyId.length === 0) {
      throw new TypeError("S3ObjectLockEvidencePublisher: kmsKeyId is required.");
    }
    this.options = options;
  }

  public async publish(artifact: EvidenceArtifact): Promise<EvidencePublishResult> {
    const { bucket } = this.options;
    const key = artifact.objectKey;
    const uri = `s3://${bucket}/${key}`;

    let existing: S3EvidenceHeadObjectOutput | null;
    try {
      existing = await this.options.s3.headObject({ Bucket: bucket, Key: key });
    } catch (cause) {
      throw publishFailed({ uri, bucket, cause, operation: "HeadObject" });
    }
    if (existing !== null) {
      throw new errors.ConflictError({
        code: EVIDENCE_OVERWRITE_REFUSED,
        message: `Evidence artifact already exists at ${uri}; refusing to overwrite (Object Lock COMPLIANCE).`,
        metadata: { uri, bucket, key },
      });
    }

    const body = Buffer.from(artifact.body, "utf8");
    const sha256Hex = createHash("sha256").update(body).digest("hex");
    const checksumBase64 = Buffer.from(sha256Hex, "hex").toString("base64");

    try {
      await this.options.s3.putObject({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: artifact.contentType,
        ContentLength: body.byteLength,
        ChecksumSHA256: checksumBase64,
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: this.options.kmsKeyId,
        IfNoneMatch: "*",
        // Object Lock headers are intentionally absent — see the file
        // header. The object inherits the bucket's COMPLIANCE default.
        Metadata: {
          "pharmax-artifact": "access-review-evidence",
          "pharmax-sha256": sha256Hex,
        },
      });
    } catch (cause) {
      if (isPreconditionFailed(cause)) {
        throw new errors.ConflictError({
          code: EVIDENCE_OVERWRITE_REFUSED,
          message: `Evidence artifact already exists at ${uri}; refusing to overwrite (Object Lock COMPLIANCE).`,
          metadata: { uri, bucket, key },
          cause,
        });
      }
      throw publishFailed({ uri, bucket, cause, operation: "PutObject" });
    }

    return {
      uri,
      sha256: sha256Hex,
      byteLength: body.byteLength,
    };
  }
}

function publishFailed(detail: {
  readonly uri: string;
  readonly bucket: string;
  readonly cause: unknown;
  readonly operation: "PutObject" | "HeadObject";
}): errors.InternalError {
  const name = detail.cause instanceof Error ? detail.cause.name : "unknown";
  const message = detail.cause instanceof Error ? detail.cause.message : String(detail.cause);
  return new errors.InternalError({
    code: EVIDENCE_PUBLISH_FAILED,
    message: `S3 ${detail.operation} failed for evidence artifact: ${name}: ${message}`,
    metadata: {
      uri: detail.uri,
      bucket: detail.bucket,
      awsErrorName: name,
      operation: detail.operation,
    },
    cause: detail.cause,
  });
}

function isPreconditionFailed(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  if ((cause as { name?: unknown }).name === "PreconditionFailed") return true;
  return (cause as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === 412;
}
