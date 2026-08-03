import { describe, expect, it, vi } from "vitest";

import {
  EVIDENCE_OVERWRITE_REFUSED,
  EVIDENCE_PUBLISH_FAILED,
  S3ObjectLockEvidencePublisher,
  type S3EvidenceObjectStore,
  type S3EvidencePutObjectInput,
} from "./s3-evidence-publisher.js";

const BUCKET = "pharmax-test-audit-archive-deadbeef";
const KMS_KEY = "arn:aws:kms:us-east-1:111122223333:key/11111111-2222-3333-4444-555555555555";

/**
 * Recording fake. `puts` is the request the publisher would have put on
 * the wire, which is what the bucket-policy assertions below evaluate.
 */
function createFakeS3(options?: { readonly existing?: boolean }): S3EvidenceObjectStore & {
  readonly puts: S3EvidencePutObjectInput[];
} {
  const puts: S3EvidencePutObjectInput[] = [];
  return {
    puts,
    async putObject(input) {
      puts.push(input);
      return { ETag: '"abc123"', VersionId: "v1" };
    },
    async headObject() {
      return options?.existing === true ? { ETag: '"existing"' } : null;
    },
  };
}

function publisher(s3: S3EvidenceObjectStore): S3ObjectLockEvidencePublisher {
  return new S3ObjectLockEvidencePublisher({
    bucket: BUCKET,
    region: "us-east-1",
    kmsKeyId: KMS_KEY,
    s3,
  });
}

const ARTIFACT = {
  objectKey: "access-reviews/org_123/2026-Q2/access-review.jsonl",
  body: '{"recordType":"header","organizationId":"org_123"}\n',
  contentType: "application/x-ndjson",
} as const;

// ---------------------------------------------------------------
// A model of the bucket policy's PUT-time DENY statements.
// ---------------------------------------------------------------
//
// `infra/terraform/modules/s3-audit-archive/main.tf` denies a PutObject
// that (a) names an Object Lock mode other than COMPLIANCE, or (b) asks
// for a retention window under the six-year floor, or (c) does not use
// SSE-KMS with the bucket's own CMK. Both Object Lock tests use the
// `IfExists` operator, so a request that sends no Object Lock header at
// all is allowed and inherits the bucket default.
//
// This models those conditions against a candidate request so the
// publisher's actual PUT can be asserted against the configuration it
// has to survive, without standing up S3.

interface CandidatePut {
  readonly ServerSideEncryption?: string;
  readonly SSEKMSKeyId?: string;
  readonly ObjectLockMode?: string;
  readonly ObjectLockRemainingRetentionDays?: number;
}

const MIN_RETENTION_DAYS = 2190;

function bucketPolicyVerdict(request: CandidatePut): { allowed: boolean; deniedBy?: string } {
  if (request.ServerSideEncryption !== "aws:kms") {
    return { allowed: false, deniedBy: "DenyUnEncryptedObjectUploads" };
  }
  if (request.SSEKMSKeyId !== undefined && request.SSEKMSKeyId !== KMS_KEY) {
    return { allowed: false, deniedBy: "DenyWrongKmsKey" };
  }
  // StringNotEqualsIfExists: absent key => condition not met => no deny.
  if (request.ObjectLockMode !== undefined && request.ObjectLockMode !== "COMPLIANCE") {
    return { allowed: false, deniedBy: "DenyNonComplianceObjectLockMode" };
  }
  // NumericLessThanIfExists: absent key => no deny.
  if (
    request.ObjectLockRemainingRetentionDays !== undefined &&
    request.ObjectLockRemainingRetentionDays < MIN_RETENTION_DAYS
  ) {
    return { allowed: false, deniedBy: "DenyShortObjectLockRetention" };
  }
  return { allowed: true };
}

describe("bucket-policy model", () => {
  // Guards the model itself. If these drift from the Terraform, the
  // assertions built on the model below mean nothing.
  it("refuses a GOVERNANCE-mode PUT", () => {
    expect(
      bucketPolicyVerdict({ ServerSideEncryption: "aws:kms", ObjectLockMode: "GOVERNANCE" })
    ).toEqual({ allowed: false, deniedBy: "DenyNonComplianceObjectLockMode" });
  });

  it("refuses a COMPLIANCE PUT that asks for a one-day window", () => {
    expect(
      bucketPolicyVerdict({
        ServerSideEncryption: "aws:kms",
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRemainingRetentionDays: 1,
      })
    ).toEqual({ allowed: false, deniedBy: "DenyShortObjectLockRetention" });
  });

  it("allows a PUT that sends no Object Lock headers", () => {
    expect(bucketPolicyVerdict({ ServerSideEncryption: "aws:kms" })).toEqual({ allowed: true });
  });
});

describe("S3ObjectLockEvidencePublisher", () => {
  it("issues a PUT the audit-archive bucket policy accepts", async () => {
    const s3 = createFakeS3();
    await publisher(s3).publish(ARTIFACT);

    const [put] = s3.puts;
    expect(put).toBeDefined();
    expect(bucketPolicyVerdict(put as CandidatePut)).toEqual({ allowed: true });
  });

  it("sends no Object Lock headers, so the object inherits the bucket default", async () => {
    const s3 = createFakeS3();
    await publisher(s3).publish(ARTIFACT);

    // The port has no Object Lock fields, so this cannot regress by a
    // caller passing GOVERNANCE — but assert on the wire shape anyway,
    // because the property that matters is what S3 receives.
    const put = s3.puts[0] as unknown as Record<string, unknown>;
    expect(put["ObjectLockMode"]).toBeUndefined();
    expect(put["ObjectLockRetainUntilDate"]).toBeUndefined();
    expect(put["ObjectLockLegalHoldStatus"]).toBeUndefined();
  });

  it("would be refused if it ever sent GOVERNANCE — that is the case the policy blocks", async () => {
    const s3 = createFakeS3();
    await publisher(s3).publish(ARTIFACT);

    // Take the publisher's real request and downgrade only the lock
    // mode. Everything else about the PUT is unchanged, which isolates
    // the mode as the reason for the refusal.
    const downgraded = { ...(s3.puts[0] as CandidatePut), ObjectLockMode: "GOVERNANCE" };
    expect(bucketPolicyVerdict(downgraded)).toEqual({
      allowed: false,
      deniedBy: "DenyNonComplianceObjectLockMode",
    });
  });

  it("encrypts with the bucket's dedicated CMK", async () => {
    const s3 = createFakeS3();
    await publisher(s3).publish(ARTIFACT);

    expect(s3.puts[0]?.ServerSideEncryption).toBe("aws:kms");
    expect(s3.puts[0]?.SSEKMSKeyId).toBe(KMS_KEY);
  });

  it("returns the sha256 and byte length of the body it wrote", async () => {
    const s3 = createFakeS3();
    const result = await publisher(s3).publish(ARTIFACT);

    const expectedBytes = Buffer.from(ARTIFACT.body, "utf8");
    expect(result.byteLength).toBe(expectedBytes.byteLength);
    expect(result.uri).toBe(`s3://${BUCKET}/${ARTIFACT.objectKey}`);
    // The checksum sent to S3 is the base64 encoding of the same digest
    // reported to the caller, so the returned hash is verifiable against
    // the stored object.
    expect(s3.puts[0]?.ChecksumSHA256).toBe(Buffer.from(result.sha256, "hex").toString("base64"));
  });

  it("sets IfNoneMatch so a racing writer cannot overwrite evidence", async () => {
    const s3 = createFakeS3();
    await publisher(s3).publish(ARTIFACT);

    expect(s3.puts[0]?.IfNoneMatch).toBe("*");
  });

  it("refuses to overwrite an artifact that already exists", async () => {
    const s3 = createFakeS3({ existing: true });

    await expect(publisher(s3).publish(ARTIFACT)).rejects.toMatchObject({
      code: EVIDENCE_OVERWRITE_REFUSED,
    });
    // Critically, it did not attempt the PUT at all.
    expect(s3.puts).toHaveLength(0);
  });

  it("maps a 412 from a racing writer onto the same refusal", async () => {
    const s3 = createFakeS3();
    s3.putObject = vi.fn().mockRejectedValue(
      Object.assign(new Error("precondition failed"), {
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      })
    );

    await expect(publisher(s3).publish(ARTIFACT)).rejects.toMatchObject({
      code: EVIDENCE_OVERWRITE_REFUSED,
    });
  });

  it("surfaces a transient S3 failure as a publish failure, not a silent skip", async () => {
    const s3 = createFakeS3();
    s3.putObject = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("throttled"), { name: "SlowDown" }));

    await expect(publisher(s3).publish(ARTIFACT)).rejects.toMatchObject({
      code: EVIDENCE_PUBLISH_FAILED,
    });
  });

  it("requires a bucket and a CMK", () => {
    const s3 = createFakeS3();
    expect(
      () =>
        new S3ObjectLockEvidencePublisher({
          bucket: "",
          region: "us-east-1",
          kmsKeyId: KMS_KEY,
          s3,
        })
    ).toThrow(TypeError);
    expect(
      () =>
        new S3ObjectLockEvidencePublisher({ bucket: BUCKET, region: "us-east-1", kmsKeyId: "", s3 })
    ).toThrow(TypeError);
  });
});
