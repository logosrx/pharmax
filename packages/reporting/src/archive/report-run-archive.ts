// ReportRunArchivePort — cross-cutting "persist + retrieve the
// CSV result set for a report run" port.
//
// One implementation per environment:
//
//   - `InMemoryReportRunArchive` — tests + ephemeral dev. Map-
//     backed; no network. Records every put for assertion-friendly
//     read-back, supports get against the recorded key.
//
//   - (future) `S3ReportRunArchive` — production. Lives in the
//     consuming app (`apps/worker`, `apps/web`) so the @pharmax/
//     reporting package stays SDK-free. The composition root
//     wires the real `@aws-sdk/client-s3` `S3Client` and adapts
//     to this port at boot.
//
// Why a port (and not a direct S3 dep in @pharmax/reporting):
//   - Two callers (web + worker) need to put + get. Each app
//     wires its own KMS / bucket / region; the package gives them
//     a single typed surface to share.
//   - Tests want a Map-backed fake; pulling in the real SDK would
//     drag a transitive AWS Region + credential chain into every
//     reporting test.
//   - A future fallback to R2 / GCS is one new adapter file, not
//     a refactor of every callsite.
//
// Tenancy: the port carries `organizationId` on every call. The
// production S3 adapter embeds it in the key path
// (`reports/{orgId}/{yyyy}/{mm}/{dd}/{reportRunId}.csv`) so a
// bucket-policy misconfig still leaves the data org-scoped at
// rest. The download path additionally re-checks the org on the
// `report_run` row before issuing the GET — defense in depth.
//
// Integrity: every put returns the canonical `{bucket, key,
// sha256Hex, sizeBytes}` triple. The caller persists these on
// `report_run`; the get path re-validates sha256 after the body
// is fetched (guards against a quietly-corrupting bucket policy
// change).
//
// PHI: report CSVs surface scalar aggregates today (status counts,
// SLA stats). When a future report's row set carries PHI fields,
// the producer MUST switch to a PHI-classified envelope and the
// adapter's KMS key MUST be one the trust boundary already
// allows for PHI (the existing `AwsKmsAdapter` `dataKey` would
// be wrong — that's per-row envelope encryption, not bulk file).
// Today's adapter wraps a CSV under SSE-KMS using a key dedicated
// to report archives; that key MUST NOT be PHI-eligible unless +
// until the policy review lands.

export interface ReportRunArchivePutInput {
  readonly organizationId: string;
  readonly reportRunId: string;
  /**
   * The CSV bytes. UTF-8 encoded (the producer is the @pharmax/
   * reporting `toCsv` helper which already emits UTF-8). Captured
   * as `Uint8Array` so the adapter doesn't have to do its own
   * `Buffer.from(string)` round-trip.
   */
  readonly csv: Uint8Array;
  /**
   * Pre-computed SHA-256 over `csv`, hex-lowercased. The caller
   * computes this once and reuses it for (a) the AWS PutObject
   * `ChecksumSHA256` header (AWS validates on upload), (b)
   * persistence on the `report_run.csvSha256Hex` column, and
   * (c) the download path's post-GET re-check. Passing it in
   * rather than recomputing inside the adapter keeps the port
   * deterministic + cheap.
   */
  readonly sha256Hex: string;
  /**
   * MIME type stamped on the object. Always `"text/csv"` for
   * Pharmax today; parameterized so a future XLSX exporter can
   * use the same port.
   */
  readonly contentType: string;
  /** Wall-clock time of the put (used by the in-memory adapter
   *  to populate the recorded `persistedAt`; production adapter
   *  uses the value AWS returns implicitly via response headers). */
  readonly persistedAt: Date;
}

export interface ReportRunArchivePutResult {
  /** Bucket the adapter wrote into. Persisted on `report_run`
   *  alongside the key so the download path can always reach the
   *  object even if the env's default bucket is later rotated. */
  readonly bucket: string;
  /** Object key — opaque to callers; the adapter chooses its own
   *  layout. */
  readonly key: string;
  /** Size of the body the adapter actually stored. Pulled from
   *  the put response (`Content-Length` echo) so callers don't
   *  have to trust their pre-computed length. */
  readonly sizeBytes: number;
}

export interface ReportRunArchiveGetInput {
  readonly organizationId: string;
  readonly reportRunId: string;
  readonly bucket: string;
  readonly key: string;
}

export interface ReportRunArchiveGetResult {
  /** The CSV bytes as written. The download route SHOULD re-check
   *  `sha256(csv) === report_run.csvSha256Hex` before streaming
   *  to the client. */
  readonly csv: Uint8Array;
  /** MIME type the object was stored with. */
  readonly contentType: string;
}

/**
 * The port. Implementations MUST treat `organizationId` as part of
 * the object's identity — keys MUST embed it (production adapter)
 * and reads SHOULD validate it before returning bytes (defense in
 * depth against a stolen key).
 */
export interface ReportRunArchivePort {
  put(input: ReportRunArchivePutInput): Promise<ReportRunArchivePutResult>;
  get(input: ReportRunArchiveGetInput): Promise<ReportRunArchiveGetResult>;
}

// ---------------------------------------------------------------------------
// Error codes the port + every adapter MAY throw.
// ---------------------------------------------------------------------------

/** The requested object key isn't in the archive. Distinct from a
 *  permissions / encryption failure so the download route can
 *  render a friendly "this run wasn't archived" page. */
export const REPORT_RUN_ARCHIVE_NOT_FOUND = "REPORT_RUN_ARCHIVE_NOT_FOUND" as const;

/** The GET succeeded but the bytes don't match the recorded
 *  sha256 (or the adapter's internal validation failed). */
export const REPORT_RUN_ARCHIVE_INTEGRITY_VIOLATION =
  "REPORT_RUN_ARCHIVE_INTEGRITY_VIOLATION" as const;

/** The adapter wrapped a vendor / transport error. Production
 *  callers should log + retry with backoff; the outbox drainer
 *  handles this automatically for scheduled-run persistence. */
export const REPORT_RUN_ARCHIVE_TRANSPORT_ERROR = "REPORT_RUN_ARCHIVE_TRANSPORT_ERROR" as const;

/** Defense-in-depth: the adapter retrieved an object whose
 *  metadata `organizationId` doesn't match the caller's. Almost
 *  always indicates a programming error (caller passed the wrong
 *  org); we fail loudly. */
export const REPORT_RUN_ARCHIVE_ORG_MISMATCH = "REPORT_RUN_ARCHIVE_ORG_MISMATCH" as const;
