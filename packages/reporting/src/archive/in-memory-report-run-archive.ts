// In-memory ReportRunArchivePort adapter.
//
// Used by tests and ephemeral dev where standing up S3 isn't
// worth the friction. Records every put for assertion-friendly
// read-back; supports get against the recorded key.
//
// NOT production-suitable:
//   - No persistence (process restart loses everything).
//   - No KMS, no SSE.
//   - No size accounting against a quota.
//
// The keys it returns are stable per (organizationId, reportRunId)
// so two puts for the same run land on the same key and the second
// overwrites the first — same shape the S3 adapter will use.

import { errors } from "@pharmax/platform-core";

import {
  REPORT_RUN_ARCHIVE_NOT_FOUND,
  REPORT_RUN_ARCHIVE_ORG_MISMATCH,
  type ReportRunArchiveGetInput,
  type ReportRunArchiveGetResult,
  type ReportRunArchivePort,
  type ReportRunArchivePutInput,
  type ReportRunArchivePutResult,
} from "./report-run-archive.js";

export interface InMemoryReportRunArchiveOptions {
  /** Bucket name reported in put results. Default: `"in-memory"`. */
  readonly bucket?: string;
}

interface Stored {
  readonly organizationId: string;
  readonly reportRunId: string;
  readonly bucket: string;
  readonly key: string;
  readonly csv: Uint8Array;
  readonly sha256Hex: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly persistedAt: Date;
}

export class InMemoryReportRunArchive implements ReportRunArchivePort {
  private readonly bucket: string;
  private readonly store = new Map<string, Stored>();

  constructor(options: InMemoryReportRunArchiveOptions = {}) {
    this.bucket = options.bucket ?? "in-memory";
  }

  async put(input: ReportRunArchivePutInput): Promise<ReportRunArchivePutResult> {
    const key = buildKey(input);
    const stored: Stored = Object.freeze({
      organizationId: input.organizationId,
      reportRunId: input.reportRunId,
      bucket: this.bucket,
      key,
      csv: new Uint8Array(input.csv),
      sha256Hex: input.sha256Hex,
      contentType: input.contentType,
      sizeBytes: input.csv.byteLength,
      persistedAt: input.persistedAt,
    });
    this.store.set(`${this.bucket}|${key}`, stored);
    return Object.freeze({
      bucket: this.bucket,
      key,
      sizeBytes: stored.sizeBytes,
    });
  }

  async get(input: ReportRunArchiveGetInput): Promise<ReportRunArchiveGetResult> {
    const found = this.store.get(`${input.bucket}|${input.key}`);
    if (found === undefined) {
      throw new errors.NotFoundError({
        code: REPORT_RUN_ARCHIVE_NOT_FOUND,
        message: `No archived CSV for key "${input.key}" in bucket "${input.bucket}".`,
        metadata: { bucket: input.bucket, key: input.key },
      });
    }
    if (found.organizationId !== input.organizationId) {
      throw new errors.AuthorizationError({
        code: REPORT_RUN_ARCHIVE_ORG_MISMATCH,
        message: "Archived CSV exists but its organizationId does not match the caller.",
        metadata: { bucket: input.bucket, key: input.key },
      });
    }
    return Object.freeze({
      csv: new Uint8Array(found.csv),
      contentType: found.contentType,
    });
  }

  /** Read-back for tests. Returns a defensive copy. */
  list(): ReadonlyArray<Stored> {
    return [...this.store.values()];
  }

  /** Drop every recorded object. */
  clear(): void {
    this.store.clear();
  }
}

/**
 * Stable key shape: `reports/{orgId}/{yyyy}/{mm}/{dd}/{reportRunId}.csv`.
 * Matches what the production S3 adapter will use so a switch
 * from in-memory to S3 in a particular test doesn't change the
 * recorded key.
 */
function buildKey(input: {
  organizationId: string;
  reportRunId: string;
  persistedAt: Date;
}): string {
  const yyyy = input.persistedAt.getUTCFullYear().toString().padStart(4, "0");
  const mm = (input.persistedAt.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = input.persistedAt.getUTCDate().toString().padStart(2, "0");
  return `reports/${input.organizationId}/${yyyy}/${mm}/${dd}/${input.reportRunId}.csv`;
}
