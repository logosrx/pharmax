import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { S3ReportRunArchive, type S3ReportRunArchiveSurface } from "./s3-report-run-archive.js";

const ORG_A = "11111111-1111-1111-1111-000000000001";
const ORG_B = "11111111-1111-1111-1111-000000000002";
const RUN_ID = "22222222-2222-2222-2222-000000000001";
const PERSISTED_AT = new Date("2026-05-28T13:00:00.000Z");

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function sha(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

interface RecordedPut {
  Bucket: string;
  Key: string;
  ContentType: string;
  ChecksumSHA256: string;
  ServerSideEncryption: string;
  SSEKMSKeyId: string;
  Metadata: Record<string, string>;
}

function buildSurface(
  input: {
    recordedPuts?: RecordedPut[];
    getResponse?: Awaited<ReturnType<S3ReportRunArchiveSurface["getObject"]>>;
    putThrows?: Error;
    getThrows?: Error;
  } = {}
): S3ReportRunArchiveSurface {
  return {
    putObject: vi.fn(async (req) => {
      if (input.putThrows !== undefined) throw input.putThrows;
      input.recordedPuts?.push({
        Bucket: req.Bucket,
        Key: req.Key,
        ContentType: req.ContentType,
        ChecksumSHA256: req.ChecksumSHA256,
        ServerSideEncryption: req.ServerSideEncryption,
        SSEKMSKeyId: req.SSEKMSKeyId,
        Metadata: { ...req.Metadata },
      });
      return { ETag: "etag-1" };
    }),
    getObject: vi.fn(async () => {
      if (input.getThrows !== undefined) throw input.getThrows;
      return input.getResponse ?? null;
    }),
  };
}

describe("S3ReportRunArchive — put", () => {
  it("composes the right key, headers, and metadata", async () => {
    const recordedPuts: RecordedPut[] = [];
    const surface = buildSurface({ recordedPuts });
    const adapter = new S3ReportRunArchive({
      s3: surface,
      bucket: "pharmax-reports-prod",
      kmsKeyId: "alias/pharmax-reports",
    });
    const csv = bytes("clinicId,total\nclinic-a,42\n");
    const hex = sha(csv);

    const result = await adapter.put({
      organizationId: ORG_A,
      reportRunId: RUN_ID,
      csv,
      sha256Hex: hex,
      contentType: "text/csv",
      persistedAt: PERSISTED_AT,
    });

    expect(result.bucket).toBe("pharmax-reports-prod");
    expect(result.key).toBe(`reports/${ORG_A}/2026/05/28/${RUN_ID}.csv`);
    expect(result.sizeBytes).toBe(csv.byteLength);

    const put = recordedPuts[0]!;
    expect(put.ServerSideEncryption).toBe("aws:kms");
    expect(put.SSEKMSKeyId).toBe("alias/pharmax-reports");
    expect(put.ContentType).toBe("text/csv");
    expect(put.ChecksumSHA256).toBe(Buffer.from(hex, "hex").toString("base64"));
    expect(put.Metadata["pharmax-org-id"]).toBe(ORG_A);
    expect(put.Metadata["pharmax-run-id"]).toBe(RUN_ID);
    expect(put.Metadata["pharmax-sha256-hex"]).toBe(hex);
  });

  it("translates a putObject failure to REPORT_RUN_ARCHIVE_TRANSPORT_ERROR", async () => {
    const surface = buildSurface({ putThrows: new Error("NoSuchBucket") });
    const adapter = new S3ReportRunArchive({
      s3: surface,
      bucket: "missing",
      kmsKeyId: "alias/k",
    });
    await expect(
      adapter.put({
        organizationId: ORG_A,
        reportRunId: RUN_ID,
        csv: bytes("x"),
        sha256Hex: sha(bytes("x")),
        contentType: "text/csv",
        persistedAt: PERSISTED_AT,
      })
    ).rejects.toMatchObject({ code: "REPORT_RUN_ARCHIVE_TRANSPORT_ERROR" });
  });
});

describe("S3ReportRunArchive — get", () => {
  it("returns the body when the sha and org metadata match", async () => {
    const csv = bytes("a,b\n1,2\n");
    const hex = sha(csv);
    const surface = buildSurface({
      getResponse: {
        Body: csv,
        ContentType: "text/csv",
        Metadata: { "pharmax-org-id": ORG_A, "pharmax-sha256-hex": hex, "pharmax-run-id": RUN_ID },
      },
    });
    const adapter = new S3ReportRunArchive({
      s3: surface,
      bucket: "pharmax-reports-prod",
      kmsKeyId: "alias/k",
    });
    const got = await adapter.get({
      organizationId: ORG_A,
      reportRunId: RUN_ID,
      bucket: "pharmax-reports-prod",
      key: `reports/${ORG_A}/2026/05/28/${RUN_ID}.csv`,
    });
    expect(new TextDecoder().decode(got.csv)).toBe("a,b\n1,2\n");
    expect(got.contentType).toBe("text/csv");
  });

  it("throws NOT_FOUND when getObject returns null", async () => {
    const surface = buildSurface({ getResponse: null });
    const adapter = new S3ReportRunArchive({
      s3: surface,
      bucket: "b",
      kmsKeyId: "alias/k",
    });
    await expect(
      adapter.get({
        organizationId: ORG_A,
        reportRunId: RUN_ID,
        bucket: "b",
        key: "k",
      })
    ).rejects.toMatchObject({ code: "REPORT_RUN_ARCHIVE_NOT_FOUND" });
  });

  it("throws ORG_MISMATCH when stored org metadata doesn't match caller", async () => {
    const csv = bytes("x");
    const hex = sha(csv);
    const surface = buildSurface({
      getResponse: {
        Body: csv,
        ContentType: "text/csv",
        Metadata: { "pharmax-org-id": ORG_B, "pharmax-sha256-hex": hex, "pharmax-run-id": RUN_ID },
      },
    });
    const adapter = new S3ReportRunArchive({
      s3: surface,
      bucket: "b",
      kmsKeyId: "alias/k",
    });
    await expect(
      adapter.get({
        organizationId: ORG_A,
        reportRunId: RUN_ID,
        bucket: "b",
        key: "k",
      })
    ).rejects.toMatchObject({ code: "REPORT_RUN_ARCHIVE_ORG_MISMATCH" });
  });

  it("throws INTEGRITY_VIOLATION when stored sha doesn't match recomputed sha", async () => {
    const csv = bytes("a,b\n1,2\n");
    const tampered = bytes("a,b\n1,99\n");
    const storedHash = sha(csv);
    const surface = buildSurface({
      getResponse: {
        Body: tampered,
        ContentType: "text/csv",
        Metadata: {
          "pharmax-org-id": ORG_A,
          "pharmax-sha256-hex": storedHash,
          "pharmax-run-id": RUN_ID,
        },
      },
    });
    const adapter = new S3ReportRunArchive({
      s3: surface,
      bucket: "b",
      kmsKeyId: "alias/k",
    });
    await expect(
      adapter.get({
        organizationId: ORG_A,
        reportRunId: RUN_ID,
        bucket: "b",
        key: "k",
      })
    ).rejects.toMatchObject({ code: "REPORT_RUN_ARCHIVE_INTEGRITY_VIOLATION" });
  });
});
