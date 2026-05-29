// S3 production adapter for `ReportRunArchivePort`.
//
// The class itself is SDK-free — it takes a narrow
// `S3ReportRunArchiveSurface` port and orchestrates put/get +
// integrity checks against it. Each consuming app
// (`apps/worker`, `apps/web`) constructs an adapter from a real
// `@aws-sdk/client-s3` `S3Client` to this surface in its boot
// path. The package therefore does not import the SDK; only the
// app-side composition roots do.
//
// Why a narrow `S3Surface` port instead of holding `S3Client`
// directly:
//   - Test isolation. A unit test passes a Map-backed fake; we
//     don't want every test to pull `@aws-sdk/client-s3` (which
//     drags region detection, credential providers, etc.).
//   - Adapter swapping. R2 / MinIO / GCS-via-S3-compat all
//     conform; we don't want to leak vendor specifics across the
//     package boundary.
//
// Key shape: `reports/{organizationId}/{yyyy}/{mm}/{dd}/{reportRunId}.csv`
// — same as `InMemoryReportRunArchive` so an integration test
// that switches adapters mid-flight (or a future cross-region
// failover) sees stable keys.
//
// Integrity:
//   - PutObject MUST be called with `ChecksumSHA256` (base64). AWS
//     validates on upload + rejects on mismatch — so our
//     pre-computed sha256 doubles as an end-to-end integrity check
//     without a second hash pass.
//   - On Get, we re-compute sha256 over the returned body. If it
//     doesn't match what AWS handed us back (or what the caller
//     expected via `report_run.csvSha256Hex`), we throw
//     `REPORT_RUN_ARCHIVE_INTEGRITY_VIOLATION`. The caller
//     decides whether to alert / refuse to serve.
//
// SSE-KMS:
//   - All puts go out with `ServerSideEncryption: "aws:kms"` and
//     the configured `SSEKMSKeyId`. The bucket policy SHOULD also
//     deny PUTs missing these headers — defense in depth against
//     a misconfigured caller forgetting them.
//
// Metadata:
//   - Object user-metadata carries `x-amz-meta-pharmax-org-id` +
//     `x-amz-meta-pharmax-run-id` (echoed at GET time). The
//     adapter cross-checks the org against the caller's
//     `organizationId` and throws `REPORT_RUN_ARCHIVE_ORG_MISMATCH`
//     on a mismatch — last-resort defense against a key-collision
//     attack.

import { createHash } from "node:crypto";

import { errors } from "@pharmax/platform-core";

import {
  REPORT_RUN_ARCHIVE_INTEGRITY_VIOLATION,
  REPORT_RUN_ARCHIVE_NOT_FOUND,
  REPORT_RUN_ARCHIVE_ORG_MISMATCH,
  REPORT_RUN_ARCHIVE_TRANSPORT_ERROR,
  type ReportRunArchiveGetInput,
  type ReportRunArchiveGetResult,
  type ReportRunArchivePort,
  type ReportRunArchivePutInput,
  type ReportRunArchivePutResult,
} from "./report-run-archive.js";

/**
 * Narrow port over `@aws-sdk/client-s3`. The bootstrap adapter
 * in `apps/worker/src/main.ts` constructs the real `S3Client` and
 * adapts to this surface. We only type the fields this adapter
 * actually reads / writes.
 */
export interface S3ReportRunArchiveSurface {
  putObject(input: {
    readonly Bucket: string;
    readonly Key: string;
    readonly Body: Uint8Array;
    readonly ContentType: string;
    readonly ContentLength: number;
    /** Base64-encoded SHA-256 of `Body`. AWS validates on upload. */
    readonly ChecksumSHA256: string;
    readonly ServerSideEncryption: "aws:kms";
    readonly SSEKMSKeyId: string;
    readonly Metadata: Record<string, string>;
  }): Promise<{
    readonly ETag?: string;
    readonly VersionId?: string;
  }>;
  getObject(input: { readonly Bucket: string; readonly Key: string }): Promise<{
    readonly Body: Uint8Array;
    readonly ContentType?: string;
    readonly Metadata?: Record<string, string>;
  } | null>;
}

export interface S3ReportRunArchiveOptions {
  readonly s3: S3ReportRunArchiveSurface;
  readonly bucket: string;
  /** KMS key ARN / alias used for SSE-KMS. REQUIRED. */
  readonly kmsKeyId: string;
}

const METADATA_ORG_KEY = "pharmax-org-id";
const METADATA_RUN_KEY = "pharmax-run-id";
const METADATA_SHA256_KEY = "pharmax-sha256-hex";

export class S3ReportRunArchive implements ReportRunArchivePort {
  private readonly s3: S3ReportRunArchiveSurface;
  private readonly bucket: string;
  private readonly kmsKeyId: string;

  constructor(options: S3ReportRunArchiveOptions) {
    this.s3 = options.s3;
    this.bucket = options.bucket;
    this.kmsKeyId = options.kmsKeyId;
  }

  async put(input: ReportRunArchivePutInput): Promise<ReportRunArchivePutResult> {
    const key = buildKey(input);
    const checksumBase64 = Buffer.from(input.sha256Hex, "hex").toString("base64");

    try {
      await this.s3.putObject({
        Bucket: this.bucket,
        Key: key,
        Body: input.csv,
        ContentType: input.contentType,
        ContentLength: input.csv.byteLength,
        ChecksumSHA256: checksumBase64,
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: this.kmsKeyId,
        Metadata: {
          [METADATA_ORG_KEY]: input.organizationId,
          [METADATA_RUN_KEY]: input.reportRunId,
          [METADATA_SHA256_KEY]: input.sha256Hex,
        },
      });
    } catch (cause) {
      throw new errors.InternalError({
        code: REPORT_RUN_ARCHIVE_TRANSPORT_ERROR,
        message: "S3 PutObject failed for report run CSV.",
        metadata: { bucket: this.bucket, key, reportRunId: input.reportRunId },
        cause,
      });
    }

    return Object.freeze({
      bucket: this.bucket,
      key,
      sizeBytes: input.csv.byteLength,
    });
  }

  async get(input: ReportRunArchiveGetInput): Promise<ReportRunArchiveGetResult> {
    let response: Awaited<ReturnType<S3ReportRunArchiveSurface["getObject"]>>;
    try {
      response = await this.s3.getObject({ Bucket: input.bucket, Key: input.key });
    } catch (cause) {
      throw new errors.InternalError({
        code: REPORT_RUN_ARCHIVE_TRANSPORT_ERROR,
        message: "S3 GetObject failed for report run CSV.",
        metadata: { bucket: input.bucket, key: input.key },
        cause,
      });
    }

    if (response === null) {
      throw new errors.NotFoundError({
        code: REPORT_RUN_ARCHIVE_NOT_FOUND,
        message: `No archived CSV at s3://${input.bucket}/${input.key}.`,
        metadata: { bucket: input.bucket, key: input.key },
      });
    }

    // Cross-check the stored org metadata against the caller.
    const storedOrg = response.Metadata?.[METADATA_ORG_KEY];
    if (storedOrg !== undefined && storedOrg !== input.organizationId) {
      throw new errors.AuthorizationError({
        code: REPORT_RUN_ARCHIVE_ORG_MISMATCH,
        message: "Archived CSV exists but its organizationId metadata does not match the caller.",
        metadata: {
          bucket: input.bucket,
          key: input.key,
          callerOrg: input.organizationId,
        },
      });
    }

    // Re-verify the body hash. We require the stored sha256 to be
    // present in metadata (the adapter ALWAYS stamps it); a missing
    // value indicates an object written by something other than
    // this adapter, which we refuse to serve.
    const storedSha = response.Metadata?.[METADATA_SHA256_KEY];
    if (storedSha === undefined) {
      throw new errors.InternalError({
        code: REPORT_RUN_ARCHIVE_INTEGRITY_VIOLATION,
        message: "Archived CSV is missing its sha256 metadata stamp.",
        metadata: { bucket: input.bucket, key: input.key },
      });
    }
    const actualSha = createHash("sha256").update(response.Body).digest("hex");
    if (actualSha !== storedSha) {
      throw new errors.InternalError({
        code: REPORT_RUN_ARCHIVE_INTEGRITY_VIOLATION,
        message: "Archived CSV sha256 does not match the stored metadata.",
        metadata: {
          bucket: input.bucket,
          key: input.key,
          expectedSha: storedSha,
          actualSha,
        },
      });
    }

    return Object.freeze({
      csv: new Uint8Array(response.Body),
      contentType: response.ContentType ?? "text/csv",
    });
  }
}

function buildKey(input: {
  readonly organizationId: string;
  readonly reportRunId: string;
  readonly persistedAt: Date;
}): string {
  const yyyy = input.persistedAt.getUTCFullYear().toString().padStart(4, "0");
  const mm = (input.persistedAt.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = input.persistedAt.getUTCDate().toString().padStart(2, "0");
  return `reports/${input.organizationId}/${yyyy}/${mm}/${dd}/${input.reportRunId}.csv`;
}
