import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryReportRunArchive } from "./in-memory-report-run-archive.js";
import {
  REPORT_RUN_ARCHIVE_NOT_FOUND,
  REPORT_RUN_ARCHIVE_ORG_MISMATCH,
} from "./report-run-archive.js";

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

describe("InMemoryReportRunArchive — happy path", () => {
  it("puts then gets back the same body", async () => {
    const adapter = new InMemoryReportRunArchive();
    const csv = bytes("a,b\n1,2\n");
    const put = await adapter.put({
      organizationId: ORG_A,
      reportRunId: RUN_ID,
      csv,
      sha256Hex: sha(csv),
      contentType: "text/csv",
      persistedAt: PERSISTED_AT,
    });
    expect(put.sizeBytes).toBe(csv.byteLength);
    const got = await adapter.get({
      organizationId: ORG_A,
      reportRunId: RUN_ID,
      bucket: put.bucket,
      key: put.key,
    });
    expect(new TextDecoder().decode(got.csv)).toBe("a,b\n1,2\n");
    expect(got.contentType).toBe("text/csv");
  });

  it("embeds organizationId, year/month/day, and runId in the key", async () => {
    const adapter = new InMemoryReportRunArchive();
    const put = await adapter.put({
      organizationId: ORG_A,
      reportRunId: RUN_ID,
      csv: bytes("x"),
      sha256Hex: sha(bytes("x")),
      contentType: "text/csv",
      persistedAt: PERSISTED_AT,
    });
    expect(put.key).toBe(`reports/${ORG_A}/2026/05/28/${RUN_ID}.csv`);
  });
});

describe("InMemoryReportRunArchive — guards", () => {
  it("returns NOT_FOUND for a missing key", async () => {
    const adapter = new InMemoryReportRunArchive();
    await expect(
      adapter.get({
        organizationId: ORG_A,
        reportRunId: RUN_ID,
        bucket: "in-memory",
        key: "reports/nope/2026/01/01/none.csv",
      })
    ).rejects.toMatchObject({ code: REPORT_RUN_ARCHIVE_NOT_FOUND });
  });

  it("returns ORG_MISMATCH if the caller's org doesn't match the stored one", async () => {
    const adapter = new InMemoryReportRunArchive();
    const put = await adapter.put({
      organizationId: ORG_A,
      reportRunId: RUN_ID,
      csv: bytes("x"),
      sha256Hex: sha(bytes("x")),
      contentType: "text/csv",
      persistedAt: PERSISTED_AT,
    });
    await expect(
      adapter.get({
        organizationId: ORG_B,
        reportRunId: RUN_ID,
        bucket: put.bucket,
        key: put.key,
      })
    ).rejects.toMatchObject({ code: REPORT_RUN_ARCHIVE_ORG_MISMATCH });
  });
});
