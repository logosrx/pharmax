// Evidence publisher port.
//
// The quarterly compliance jobs (access review, vendor review,
// change-log aggregate) produce evidence artifacts that MUST be
// written to the audit-archive bucket — an S3 bucket with Object
// Lock COMPLIANCE retention so once-written-cannot-be-overwritten
// for the auditor's retention period (six years per HIPAA
// § 164.530(j)).
//
// We do NOT inline an AWS SDK call here for two reasons:
//
//   1. Tests must not require AWS. The port lets tests inject a
//      `FilesystemEvidencePublisher` or a `RecordingEvidencePublisher`
//      so the job logic is exercised against the same shape the
//      production adapter satisfies.
//
//   2. The "production" adapter that talks to S3 + Object Lock is
//      owned by infra (Lane 2 Terraform). The shape declared here
//      is the contract that adapter must satisfy. Wiring is in
//      `apps/worker/src/main.ts` once both pieces land — see
//      `apps/worker/src/compliance/README.md`.
//
// PHI invariant: every evidence body passed to `publish()` is
// PHI-free by construction (operator + role + scope metadata only;
// activity aggregates are counts, not row dumps). Adapters MUST
// NOT log or store the body anywhere outside the audit-archive
// bucket.

import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

export interface EvidenceArtifact {
  /**
   * Object key under the audit-archive bucket. The first path
   * segment is always the artifact CATEGORY (e.g. "access-reviews",
   * "vendor-reviews", "change-logs", "evidence-packs"). The full key
   * pattern is documented per call site in this folder.
   */
  readonly objectKey: string;
  /** Raw UTF-8 body. Caller is responsible for newline conventions. */
  readonly body: string;
  /**
   * MIME-style content type. `"application/x-ndjson"` for JSONL,
   * `"text/markdown"` for reports, `"application/json"` for single
   * documents.
   */
  readonly contentType: string;
}

export interface EvidencePublishResult {
  /** The URI (or local path) the artifact landed at. */
  readonly uri: string;
  /** SHA-256 hex digest of the body (Object Lock evidence guarantee). */
  readonly sha256: string;
  /** Byte length of the body as written. */
  readonly byteLength: number;
}

export interface EvidencePublisher {
  publish(artifact: EvidenceArtifact): Promise<EvidencePublishResult>;
}

/**
 * Default dev / test publisher: writes under a local directory
 * (matching the production S3 key structure) so the same artifact
 * lookup works in CI snapshots and the auditor sandbox. NOT for
 * production — production must use the S3 Object Lock adapter.
 */
export class FilesystemEvidencePublisher implements EvidencePublisher {
  private readonly rootDir: string;

  constructor(opts: { rootDir: string }) {
    this.rootDir = resolve(opts.rootDir);
  }

  async publish(artifact: EvidenceArtifact): Promise<EvidencePublishResult> {
    const filePath = resolve(this.rootDir, artifact.objectKey);
    mkdirSync(dirname(filePath), { recursive: true });
    const buf = Buffer.from(artifact.body, "utf8");
    writeFileSync(filePath, buf);
    const sha = createHash("sha256").update(buf).digest("hex");
    return {
      uri: `file://${filePath}`,
      sha256: sha,
      byteLength: buf.byteLength,
    };
  }
}

/** Test publisher: keeps every artifact in memory; no disk side effects. */
export class RecordingEvidencePublisher implements EvidencePublisher {
  readonly artifacts: Array<EvidenceArtifact & EvidencePublishResult> = [];

  async publish(artifact: EvidenceArtifact): Promise<EvidencePublishResult> {
    const buf = Buffer.from(artifact.body, "utf8");
    const sha = createHash("sha256").update(buf).digest("hex");
    const result: EvidencePublishResult = {
      uri: `recording://${artifact.objectKey}`,
      sha256: sha,
      byteLength: buf.byteLength,
    };
    this.artifacts.push({ ...artifact, ...result });
    return result;
  }
}

/**
 * Render an array of records as JSONL (one JSON object per line).
 * Deterministic key ordering is the caller's responsibility — the
 * evidence-pack manifest depends on byte-identical re-runs.
 */
export function renderJsonl(records: ReadonlyArray<Record<string, unknown>>): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
}
