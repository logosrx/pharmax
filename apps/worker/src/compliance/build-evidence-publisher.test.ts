import { describe, expect, it, vi } from "vitest";

import { buildEvidencePublisher } from "./build-evidence-publisher.js";
import { FilesystemEvidencePublisher } from "./evidence-publisher.js";
import {
  S3ObjectLockEvidencePublisher,
  type S3EvidenceObjectStore,
} from "./s3-evidence-publisher.js";

const s3: S3EvidenceObjectStore = {
  async putObject() {
    return {};
  },
  async headObject() {
    return null;
  },
};

function createLogger(): {
  readonly warn: ReturnType<typeof vi.fn>;
  readonly info: ReturnType<typeof vi.fn>;
} {
  return { warn: vi.fn(), info: vi.fn() };
}

/** The logger port is wider than this factory uses; cast at the seam. */
function loggerArg(
  l: ReturnType<typeof createLogger>
): Parameters<typeof buildEvidencePublisher>[0]["logger"] {
  return l as unknown as Parameters<typeof buildEvidencePublisher>[0]["logger"];
}

const CONFIGURED = {
  AWS_REGION: "us-east-1",
  AUDIT_ARCHIVE_S3_BUCKET: "pharmax-prod-audit-archive-deadbeef",
  AUDIT_ARCHIVE_S3_KMS_KEY_ID: "arn:aws:kms:us-east-1:111122223333:key/abc",
  QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT: "./evidence",
} as const;

describe("buildEvidencePublisher", () => {
  it("uses the S3 Object Lock publisher in production when the archive is configured", async () => {
    const logger = createLogger();
    const publisher = await buildEvidencePublisher({
      logger: loggerArg(logger),
      env: { NODE_ENV: "production", ...CONFIGURED },
      s3,
    });

    expect(publisher).toBeInstanceOf(S3ObjectLockEvidencePublisher);
  });

  it("refuses to boot in production when the archive bucket is unset", async () => {
    // The behaviour being replaced was a warning plus a write to a
    // container filesystem the next deployment discards — an operator
    // saw a line saying the review ran while the evidence did not
    // exist. Failing the boot moves that from the quarter boundary to
    // deploy time, where the ECS circuit breaker rolls it back.
    const logger = createLogger();

    await expect(
      buildEvidencePublisher({
        logger: loggerArg(logger),
        env: {
          NODE_ENV: "production",
          AWS_REGION: "us-east-1",
          QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT: "./evidence",
        },
        s3,
      })
    ).rejects.toThrow(/AUDIT_ARCHIVE_S3_BUCKET is required/);
  });

  it("does not silently fall back to the filesystem in production", async () => {
    const logger = createLogger();

    await expect(
      buildEvidencePublisher({
        logger: loggerArg(logger),
        env: {
          NODE_ENV: "production",
          QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT: "./evidence",
        },
        s3,
      })
    ).rejects.toThrow();

    // The old failure mode was precisely "warn, then carry on".
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("names QUARTERLY_ACCESS_REVIEW_ENABLED=false as the way to decline the job", async () => {
    // An operator who genuinely does not want the job needs a supported
    // exit that is not "misconfigure the bucket".
    const logger = createLogger();

    await expect(
      buildEvidencePublisher({
        logger: loggerArg(logger),
        env: { NODE_ENV: "production", QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT: "./evidence" },
        s3,
      })
    ).rejects.toThrow(/QUARTERLY_ACCESS_REVIEW_ENABLED=false/);
  });

  it("refuses a bucket without its CMK, in any environment", async () => {
    // SSE-KMS with the dedicated key is what the bucket policy's
    // DenyWrongKmsKey statement pins; booting without it would produce
    // a publisher whose every PUT is denied at the quarter boundary.
    const logger = createLogger();

    await expect(
      buildEvidencePublisher({
        logger: loggerArg(logger),
        env: {
          NODE_ENV: "development",
          AWS_REGION: "us-east-1",
          AUDIT_ARCHIVE_S3_BUCKET: "some-bucket",
          QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT: "./evidence",
        },
        s3,
      })
    ).rejects.toThrow(/AUDIT_ARCHIVE_S3_KMS_KEY_ID/);
  });

  it("refuses a bucket without a region", async () => {
    const logger = createLogger();

    await expect(
      buildEvidencePublisher({
        logger: loggerArg(logger),
        env: {
          NODE_ENV: "development",
          AUDIT_ARCHIVE_S3_BUCKET: "some-bucket",
          AUDIT_ARCHIVE_S3_KMS_KEY_ID: "arn:aws:kms:us-east-1:111122223333:key/abc",
          QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT: "./evidence",
        },
        s3,
      })
    ).rejects.toThrow(/AWS_REGION/);
  });

  it("keeps the filesystem publisher for local development", async () => {
    const logger = createLogger();
    const publisher = await buildEvidencePublisher({
      logger: loggerArg(logger),
      env: { NODE_ENV: "development", QUARTERLY_ACCESS_REVIEW_EVIDENCE_ROOT: "./evidence" },
      s3,
    });

    expect(publisher).toBeInstanceOf(FilesystemEvidencePublisher);
    // Still says so out loud — a developer should know the pack they
    // just generated is not durable.
    expect(logger.warn).toHaveBeenCalledWith(
      "worker.quarterly_access_review.filesystem_publisher",
      expect.objectContaining({ evidenceRoot: "./evidence" })
    );
  });
});
