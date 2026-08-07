// Evidence-publisher selection.
//
// Mirrors `buildMerklePublisher` in ../security/daily-merkle-root-loop.ts:
// same bucket, same env vars, same posture. Kept out of `main.ts` so the
// production branch is reachable from a unit test.
//
// ---------------------------------------------------------------
// Why an unconfigured publisher refuses the boot in production
// ---------------------------------------------------------------
//
// The behaviour this replaces was a WARN log plus a write to a container
// filesystem that the next deployment discards. That is the worst of the
// available options: an operator sees a line claiming the quarterly
// access review ran, and the evidence it refers to does not exist. A
// review that appears to have happened and left nothing behind is worse
// than one that visibly did not run, because only the second gets fixed.
//
// Given that, there are two honest choices — decline to start the loop,
// or refuse the boot. This throws.
//
//   - Declining to start the loop fails at the QUARTER BOUNDARY, up to
//     three months after the misconfiguration shipped, and announces
//     itself only as an absent log line on a task that otherwise looks
//     healthy. Nobody is watching for the absence of a thing.
//   - Refusing the boot fails at DEPLOY TIME, while someone is watching
//     the deployment. The ECS circuit breaker rolls the service back on
//     boot failure, so the misconfiguration cannot reach a steady state
//     that merely looks fine.
//
// `buildMerklePublisher` already hard-fails on this exact env var for
// this exact bucket, so a production worker that could not durably store
// evidence would already have been refused. Restating it here keeps the
// two publishers independent: neither silently relies on the other's
// precondition.
//
// A deliberate `QUARTERLY_ACCESS_REVIEW_ENABLED=false` is NOT this case
// — that is an operator choosing not to run the job, already covered by
// its own production warning in main.ts, and it is not overridden here.

import type { logger as loggerContract } from "@pharmax/platform-core";

import { FilesystemEvidencePublisher, type EvidencePublisher } from "./evidence-publisher.js";
import {
  S3ObjectLockEvidencePublisher,
  type S3EvidenceObjectStore,
} from "./s3-evidence-publisher.js";

type Logger = loggerContract.Logger;

export interface EvidencePublisherEnv {
  readonly NODE_ENV: "development" | "test" | "production";
  readonly AWS_REGION?: string | undefined;
  readonly AUDIT_ARCHIVE_S3_BUCKET?: string | undefined;
  readonly AUDIT_ARCHIVE_S3_KMS_KEY_ID?: string | undefined;
  readonly QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT: string;
}

export interface BuildEvidencePublisherOptions {
  readonly logger: Logger;
  readonly env: EvidencePublisherEnv;
  /** Inject in tests to avoid resolving the AWS SDK. */
  readonly s3?: S3EvidenceObjectStore;
}

/**
 * Resolve the evidence publisher for this process.
 *
 * Production with the audit archive configured → S3 Object Lock.
 * Production without it → throws; see the file header.
 * Anything else → local filesystem, with a warning.
 */
export async function buildEvidencePublisher(
  options: BuildEvidencePublisherOptions
): Promise<EvidencePublisher> {
  const { logger, env } = options;
  const bucket = env.AUDIT_ARCHIVE_S3_BUCKET;

  if (typeof bucket !== "string" || bucket.length === 0) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "Refusing to boot the quarterly access-review loop in production: " +
          "AUDIT_ARCHIVE_S3_BUCKET is required so the evidence pack lands in the " +
          "Object Lock archive. The filesystem publisher writes to container-local " +
          "storage that is discarded on the next deployment, which would leave the " +
          "SOC 2 CC6.2 evidence pack non-existent while the run appears to have " +
          "succeeded. Set AUDIT_ARCHIVE_S3_BUCKET + AUDIT_ARCHIVE_S3_KMS_KEY_ID, or " +
          "set QUARTERLY_ACCESS_REVIEW_ENABLED=false to decline the job explicitly."
      );
    }
    logger.warn("worker.quarterly_access_review.filesystem_publisher", {
      reason:
        "AUDIT_ARCHIVE_S3_BUCKET unset; access-review evidence packs are written to the local filesystem and are not durable.",
      evidenceRoot: env.QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT,
    });
    return new FilesystemEvidencePublisher({
      rootDir: env.QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT,
    });
  }

  const kmsKeyId = env.AUDIT_ARCHIVE_S3_KMS_KEY_ID;
  if (typeof kmsKeyId !== "string" || kmsKeyId.length === 0) {
    throw new Error(
      "AUDIT_ARCHIVE_S3_BUCKET is set but AUDIT_ARCHIVE_S3_KMS_KEY_ID is not. " +
        "SSE-KMS with the dedicated audit-archive CMK is required — the bucket policy " +
        "denies any PUT that names another key."
    );
  }
  const region = env.AWS_REGION;
  if (typeof region !== "string" || region.length === 0) {
    throw new Error("AUDIT_ARCHIVE_S3_BUCKET requires AWS_REGION to be set.");
  }

  const s3 = options.s3 ?? (await buildS3EvidenceObjectStore(region));
  logger.info("worker.quarterly_access_review.s3_publisher", { bucket, region });
  return new S3ObjectLockEvidencePublisher({ bucket, region, kmsKeyId, s3 });
}

/**
 * Adapter from the real `@aws-sdk/client-s3` client to the narrow port.
 * Dynamic import keeps the SDK off the cold-start path for deployments
 * that do not write evidence.
 */
export async function buildS3EvidenceObjectStore(region: string): Promise<S3EvidenceObjectStore> {
  const { S3Client, PutObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region });
  return {
    async putObject(input) {
      const out = await client.send(
        new PutObjectCommand({
          Bucket: input.Bucket,
          Key: input.Key,
          Body: input.Body,
          ContentType: input.ContentType,
          ContentLength: input.ContentLength,
          ChecksumSHA256: input.ChecksumSHA256,
          ServerSideEncryption: input.ServerSideEncryption,
          SSEKMSKeyId: input.SSEKMSKeyId,
          ...(input.IfNoneMatch !== undefined ? { IfNoneMatch: input.IfNoneMatch } : {}),
          ...(input.Metadata !== undefined ? { Metadata: input.Metadata } : {}),
        })
      );
      return {
        ...(out.ETag !== undefined ? { ETag: out.ETag } : {}),
        ...(out.VersionId !== undefined ? { VersionId: out.VersionId } : {}),
      };
    },
    async headObject(input) {
      try {
        const out = await client.send(
          new HeadObjectCommand({ Bucket: input.Bucket, Key: input.Key })
        );
        return {
          ...(out.ETag !== undefined ? { ETag: out.ETag } : {}),
          ...(out.VersionId !== undefined ? { VersionId: out.VersionId } : {}),
          ...(out.ContentLength !== undefined ? { ContentLength: out.ContentLength } : {}),
          ...(out.LastModified !== undefined ? { LastModified: out.LastModified } : {}),
        };
      } catch (cause) {
        if (isNotFound(cause)) return null;
        throw cause;
      }
    },
  };
}

function isNotFound(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const name = (cause as { name?: unknown }).name;
  if (name === "NotFound" || name === "NoSuchKey") return true;
  return (cause as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === 404;
}
