import { describe, expect, it } from "vitest";

import {
  InMemoryManifestPublisher,
  MANIFEST_SCHEMA_VERSION,
  MERKLE_MANIFEST_OVERWRITE_REFUSED,
  MERKLE_PUBLISH_FAILED,
  MIN_RETENTION_DAYS,
  S3ObjectLockPublisher,
  SECURITY_MANIFEST_PUBLISH_FAILED,
  buildSignedMerkleManifest,
  manifestObjectKey,
  type SignedMerkleManifest,
} from "./publish-merkle-manifest.js";
import type {
  S3HeadObjectOutput,
  S3ObjectLockClient,
  S3PutObjectInput,
  S3PutObjectOutput,
} from "./s3-object-lock-client.js";

const ORG = "11111111-1111-7111-a111-111111111111";

function makeManifest(): SignedMerkleManifest {
  return buildSignedMerkleManifest({
    organizationId: ORG,
    periodStart: new Date(Date.UTC(2026, 4, 24, 0, 0, 0)),
    periodEnd: new Date(Date.UTC(2026, 4, 25, 0, 0, 0)),
    computedAt: new Date(Date.UTC(2026, 4, 25, 2, 0, 0)),
    signedAt: new Date(Date.UTC(2026, 4, 25, 2, 1, 0)),
    leafCount: 12,
    firstSeq: 100n,
    lastSeq: 111n,
    rootHash: Buffer.alloc(32, 0xab),
    signature: Buffer.alloc(64, 0xcd),
    signerKid: "ed25519:deadbeef",
    algorithm: "ed25519",
    signingDomainTag: "pharmax/audit-merkle/v1",
  });
}

describe("manifestObjectKey", () => {
  it("produces a YYYY/MM/DD layout keyed by organization", () => {
    const key = manifestObjectKey({
      organizationId: ORG,
      periodStart: new Date(Date.UTC(2026, 0, 5, 0, 0, 0)),
    });
    expect(key).toBe(`${ORG}/2026/01/05/merkle-manifest.json`);
  });

  it("zero-pads single-digit months and days", () => {
    expect(
      manifestObjectKey({
        organizationId: ORG,
        periodStart: new Date(Date.UTC(2026, 8, 1, 0, 0, 0)),
      })
    ).toBe(`${ORG}/2026/09/01/merkle-manifest.json`);
  });
});

describe("buildSignedMerkleManifest", () => {
  it("normalizes Dates to ISO strings and BigInts to decimal strings", () => {
    const manifest = makeManifest();
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.periodStart).toBe("2026-05-24T00:00:00.000Z");
    expect(manifest.firstSeq).toBe("100");
    expect(manifest.lastSeq).toBe("111");
    expect(manifest.rootHashHex).toMatch(/^(ab){32}$/);
  });

  it("preserves null seqs for empty windows", () => {
    const manifest = buildSignedMerkleManifest({
      organizationId: ORG,
      periodStart: new Date(Date.UTC(2026, 4, 24, 0, 0, 0)),
      periodEnd: new Date(Date.UTC(2026, 4, 25, 0, 0, 0)),
      computedAt: new Date(),
      signedAt: new Date(),
      leafCount: 0,
      firstSeq: null,
      lastSeq: null,
      rootHash: Buffer.alloc(32, 0x00),
      signature: Buffer.alloc(64, 0x00),
      signerKid: "ed25519:deadbeef",
      algorithm: "ed25519",
      signingDomainTag: "pharmax/audit-merkle/v1",
    });
    expect(manifest.firstSeq).toBeNull();
    expect(manifest.lastSeq).toBeNull();
    expect(manifest.leafCount).toBe(0);
  });
});

describe("InMemoryManifestPublisher", () => {
  it("publishes a manifest and returns a stable URI", async () => {
    const publisher = new InMemoryManifestPublisher();
    const manifest = makeManifest();
    const result = await publisher.publish(manifest);
    expect(result.uri).toBe(`memory://audit-archive/${ORG}/2026/05/24/merkle-manifest.json`);
    const fetched = await publisher.fetch(result.uri);
    expect(fetched).toEqual(manifest);
  });

  it("refuses to overwrite an existing manifest", async () => {
    const publisher = new InMemoryManifestPublisher();
    await publisher.publish(makeManifest());
    await expect(publisher.publish(makeManifest())).rejects.toMatchObject({
      code: SECURITY_MANIFEST_PUBLISH_FAILED,
    });
  });
});

/**
 * Build an in-memory fake S3 client that tracks state and lets us
 * assert on exact PutObject input shape (Object Lock, KMS, etc.).
 */
interface FakeS3State {
  readonly objects: Map<string, { manifest: SignedMerkleManifest; meta: S3HeadObjectOutput }>;
  readonly puts: S3PutObjectInput[];
  readonly heads: { Bucket: string; Key: string }[];
  readonly clock: () => Date;
}

function buildFakeS3Client(opts?: {
  readonly throwOnPut?: () => Error;
  readonly throwOnHead?: () => Error;
  readonly clock?: () => Date;
}): { client: S3ObjectLockClient; state: FakeS3State } {
  const state: FakeS3State = {
    objects: new Map(),
    puts: [],
    heads: [],
    clock: opts?.clock ?? (() => new Date(Date.UTC(2026, 4, 25, 2, 0, 0))),
  };
  const client: S3ObjectLockClient = {
    async headObject(input) {
      state.heads.push({ Bucket: input.Bucket, Key: input.Key });
      if (opts?.throwOnHead !== undefined) throw opts.throwOnHead();
      const entry = state.objects.get(`${input.Bucket}/${input.Key}`);
      return entry === undefined ? null : entry.meta;
    },
    async putObject(input): Promise<S3PutObjectOutput> {
      state.puts.push(input);
      if (opts?.throwOnPut !== undefined) throw opts.throwOnPut();
      const fullKey = `${input.Bucket}/${input.Key}`;
      if (input.IfNoneMatch === "*" && state.objects.has(fullKey)) {
        const err: Error & { name: string; $metadata?: { httpStatusCode: number } } = Object.assign(
          new Error("PreconditionFailed"),
          { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }
        );
        throw err;
      }
      const manifest = JSON.parse(input.Body.toString()) as SignedMerkleManifest;
      state.objects.set(fullKey, {
        manifest,
        meta: {
          ETag: '"etag-' + state.objects.size + '"',
          VersionId: "v" + state.objects.size,
          ContentLength: typeof input.Body === "string" ? input.Body.length : input.Body.length,
          LastModified: state.clock(),
          ObjectLockMode: input.ObjectLockMode,
          ObjectLockRetainUntilDate: input.ObjectLockRetainUntilDate,
        },
      });
      return {
        ETag: '"etag-' + (state.objects.size - 1) + '"',
        VersionId: "v" + (state.objects.size - 1),
      };
    },
    async getObject(input) {
      const entry = state.objects.get(`${input.Bucket}/${input.Key}`);
      if (entry === undefined) return null;
      return {
        Body: Buffer.from(JSON.stringify(entry.manifest), "utf8"),
        ETag: entry.meta.ETag ?? '"etag"',
        ...(entry.meta.VersionId !== undefined ? { VersionId: entry.meta.VersionId } : {}),
        ContentType: "application/json",
        LastModified: entry.meta.LastModified ?? state.clock(),
      };
    },
  };
  return { client, state };
}

describe("S3ObjectLockPublisher", () => {
  const bucket = "pharmax-audit-archive-prod";
  const region = "us-east-1";
  const kmsKeyId = "arn:aws:kms:us-east-1:000000000000:key/audit-archive";

  it("PUTs the manifest with COMPLIANCE Object Lock, SSE-KMS, and IfNoneMatch:*", async () => {
    const { client, state } = buildFakeS3Client();
    const publisher = new S3ObjectLockPublisher({
      bucket,
      region,
      retentionDays: 7 * 365,
      kmsKeyId,
      s3Client: client,
    });
    const manifest = makeManifest();
    const result = await publisher.publish(manifest);

    expect(result.uri).toBe(`s3://${bucket}/${ORG}/2026/05/24/merkle-manifest.json`);
    expect(result.eTag).toBe('"etag-0"');
    expect(result.versionId).toBe("v0");
    expect(result.idempotent).toBe(false);

    expect(state.puts).toHaveLength(1);
    const put = state.puts[0]!;
    expect(put.Bucket).toBe(bucket);
    expect(put.Key).toBe(`${ORG}/2026/05/24/merkle-manifest.json`);
    expect(put.ContentType).toBe("application/json");
    expect(put.ObjectLockMode).toBe("COMPLIANCE");
    expect(put.ObjectLockLegalHoldStatus).toBe("OFF");
    expect(put.ServerSideEncryption).toBe("aws:kms");
    expect(put.SSEKMSKeyId).toBe(kmsKeyId);
    expect(put.IfNoneMatch).toBe("*");
    expect(put.Metadata).toMatchObject({
      "pharmax-org": ORG,
      "pharmax-period-start": manifest.periodStart,
      "pharmax-period-end": manifest.periodEnd,
      "pharmax-schema-version": "1",
      "pharmax-signer-kid": manifest.signerKid,
    });
  });

  it("sets retain-until to now + retentionDays", async () => {
    const fixedNow = new Date(Date.UTC(2026, 4, 25, 2, 0, 0));
    const { client, state } = buildFakeS3Client({ clock: () => fixedNow });
    const publisher = new S3ObjectLockPublisher({
      bucket,
      region,
      retentionDays: 7 * 365,
      kmsKeyId,
      s3Client: client,
      clock: () => fixedNow,
    });
    await publisher.publish(makeManifest());
    const put = state.puts[0]!;
    const expected = new Date(fixedNow.getTime() + 7 * 365 * 86_400_000);
    expect(put.ObjectLockRetainUntilDate.getTime()).toBe(expected.getTime());
  });

  it("idempotent path: a second publish observes the existing manifest and does NOT re-PUT", async () => {
    const { client, state } = buildFakeS3Client();
    const publisher = new S3ObjectLockPublisher({
      bucket,
      region,
      retentionDays: 365,
      kmsKeyId,
      s3Client: client,
    });
    const first = await publisher.publish(makeManifest());
    expect(first.idempotent).toBe(false);
    expect(state.puts).toHaveLength(1);

    const second = await publisher.publish(makeManifest());
    expect(second.idempotent).toBe(true);
    expect(second.uri).toBe(first.uri);
    expect(second.eTag).toBe(first.eTag);
    expect(state.puts).toHaveLength(1);
    expect(state.heads).toHaveLength(2);
  });

  it("explicitly maps a 412 PreconditionFailed from S3 to MERKLE_MANIFEST_OVERWRITE_REFUSED", async () => {
    // Simulate a race where HeadObject reports empty (e.g. eventual
    // consistency) but PutObject's IfNoneMatch:* fires.
    let putCount = 0;
    const { client } = buildFakeS3Client();
    const racingClient: S3ObjectLockClient = {
      async headObject() {
        return null;
      },
      async putObject(input) {
        putCount += 1;
        if (input.IfNoneMatch === "*") {
          const err: Error & { name: string; $metadata?: { httpStatusCode: number } } =
            Object.assign(new Error("PreconditionFailed"), {
              name: "PreconditionFailed",
              $metadata: { httpStatusCode: 412 },
            });
          throw err;
        }
        return client.putObject(input);
      },
      getObject: client.getObject,
    };
    const publisher = new S3ObjectLockPublisher({
      bucket,
      region,
      retentionDays: 365,
      kmsKeyId,
      s3Client: racingClient,
    });
    await expect(publisher.publish(makeManifest())).rejects.toMatchObject({
      code: MERKLE_MANIFEST_OVERWRITE_REFUSED,
    });
    expect(putCount).toBe(1);
  });

  it("maps an unexpected AWS error during PutObject to MERKLE_PUBLISH_FAILED", async () => {
    const { client } = buildFakeS3Client({
      throwOnPut: () =>
        Object.assign(new Error("Service unavailable"), { name: "ServiceUnavailable" }),
    });
    const publisher = new S3ObjectLockPublisher({
      bucket,
      region,
      retentionDays: 365,
      kmsKeyId,
      s3Client: client,
    });
    await expect(publisher.publish(makeManifest())).rejects.toMatchObject({
      code: MERKLE_PUBLISH_FAILED,
    });
  });

  it("fetch() round-trips a published manifest by URI", async () => {
    const { client } = buildFakeS3Client();
    const publisher = new S3ObjectLockPublisher({
      bucket,
      region,
      retentionDays: 365,
      kmsKeyId,
      s3Client: client,
    });
    const original = makeManifest();
    const result = await publisher.publish(original);
    const fetched = await publisher.fetch(result.uri);
    expect(fetched).toEqual(original);
  });

  it("fetch() returns null when the manifest is not present", async () => {
    const { client } = buildFakeS3Client();
    const publisher = new S3ObjectLockPublisher({
      bucket,
      region,
      retentionDays: 365,
      kmsKeyId,
      s3Client: client,
    });
    const fetched = await publisher.fetch(`s3://${bucket}/${ORG}/2024/01/01/merkle-manifest.json`);
    expect(fetched).toBeNull();
  });

  it("rejects construction with missing bucket / kmsKeyId / too-short retention", () => {
    const { client } = buildFakeS3Client();
    expect(
      () =>
        new S3ObjectLockPublisher({
          bucket: "",
          region,
          retentionDays: 365,
          kmsKeyId,
          s3Client: client,
        })
    ).toThrow(/bucket/);
    expect(
      () =>
        new S3ObjectLockPublisher({
          bucket,
          region,
          retentionDays: 365,
          kmsKeyId: "",
          s3Client: client,
        })
    ).toThrow(/kmsKeyId/);
    expect(
      () =>
        new S3ObjectLockPublisher({
          bucket,
          region,
          retentionDays: MIN_RETENTION_DAYS - 1,
          kmsKeyId,
          s3Client: client,
        })
    ).toThrow(/retention/);
  });
});
