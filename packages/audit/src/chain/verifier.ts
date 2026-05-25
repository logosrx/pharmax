// Chain verifier.
//
// Walks audit_log rows for one tenant in seq order and recomputes
// each row's entryHash with the SAME canonical encoder the writer
// uses. Asserts two invariants per row:
//
//   1. recomputed entryHash byte-matches the stored entryHash.
//   2. prevHash byte-matches the previous row's entryHash (or NULL
//      on the genesis row, or `startPrevHash` on a resumed walk).
//   3. seq increases monotonically by exactly 1.
//
// On any inconsistency, throws InternalError(AUDIT_CHAIN_BROKEN)
// pointing at the offending seq. The verifier is "fail-fast" —
// auditors generally want to investigate the first break rather
// than collect a list of mismatches.
//
// Usage:
//
//   - Phase 5 daily Merkle signing job: verify each tenant's chain,
//     then sign the tip hash.
//   - SOC 2 evidence collection: an auditor runs this against a
//     date-bounded slice and the report is the verification artifact.
//   - Incident response: an analyst runs it with a tight [start, end]
//     window when they suspect tampering.
//
// What this does NOT do:
//
//   - Re-execute the original action. The chain proves audit_log
//     hasn't been mutated; it doesn't prove the original action
//     succeeded. That signal lives in command_log.
//   - Lock anything. Verification is SELECT-only and uses standard
//     read-committed snapshot semantics. Concurrent writes during a
//     verification run simply appear "after" the verified window.
//   - Decode PHI. audit_log is designed to be PHI-free; the verifier
//     re-encodes scope/metadata blobs through the canonical encoder
//     without inspecting them.

import { auditChainBrokenError } from "../errors.js";
import { computeAuditEntryHash } from "./encoder.js";

/**
 * One row's worth of data, as read back from `audit_log`.
 *
 * Mirrors `CanonicalAuditEntry` from the encoder, plus the stored
 * `entryHash`. The verifier recomputes entryHash from the other
 * fields and compares.
 */
export interface AuditChainRow {
  readonly organizationId: string;
  readonly seq: bigint;
  readonly prevHash: Buffer | null;
  readonly entryHash: Buffer;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly actorUserId: string | null;
  readonly scope: unknown;
  readonly metadata: unknown;
  readonly occurredAt: Date;
}

/**
 * Source of rows for the verifier. An interface (not the Prisma tx)
 * so tests can pass in-memory arrays without a fake DB.
 *
 * Implementations MUST:
 *   - Yield rows in ascending `seq` order.
 *   - Filter to a single `organizationId`.
 *   - Respect `startSeq` (inclusive, default = 1) and `endSeq`
 *     (inclusive, default = +∞).
 *
 * Implementations SHOULD batch under the hood — the chain may be
 * very long. A one-shot Array iterator is fine for tests.
 */
export interface ChainSource {
  iterate(opts: {
    readonly organizationId: string;
    readonly startSeq?: bigint;
    readonly endSeq?: bigint;
  }): AsyncIterable<AuditChainRow>;
}

export interface VerifyResult {
  readonly organizationId: string;
  readonly verifiedRows: number;
  readonly firstSeq: bigint | null;
  readonly lastSeq: bigint | null;
  readonly lastHash: Buffer | null;
}

/**
 * Walk the chain for one tenant. Fails fast on the first break.
 *
 * `startPrevHash` lets callers resume verification from a previously
 * trusted point — pass the entryHash of the row at `startSeq - 1`.
 * If `startSeq` is 1 (or omitted), the verifier expects the genesis
 * row (prevHash = NULL).
 */
export async function verifyChain(
  source: ChainSource,
  args: {
    readonly organizationId: string;
    readonly startSeq?: bigint;
    readonly endSeq?: bigint;
    readonly startPrevHash?: Buffer | null;
  }
): Promise<VerifyResult> {
  const startSeq = args.startSeq ?? 1n;

  let verifiedRows = 0;
  let firstSeq: bigint | null = null;
  let lastSeq: bigint | null = null;
  let lastHash: Buffer | null = null;
  let expectedPrev: Buffer | null = args.startPrevHash ?? null;
  let expectedSeq: bigint = startSeq;

  const iteratorArgs: {
    organizationId: string;
    startSeq?: bigint;
    endSeq?: bigint;
  } = { organizationId: args.organizationId };
  if (args.startSeq !== undefined) iteratorArgs.startSeq = args.startSeq;
  if (args.endSeq !== undefined) iteratorArgs.endSeq = args.endSeq;

  for await (const row of source.iterate(iteratorArgs)) {
    if (firstSeq === null) firstSeq = row.seq;

    if (row.seq !== expectedSeq) {
      throw auditChainBrokenError({
        organizationId: args.organizationId,
        seq: row.seq,
        reason: `seq gap: expected ${expectedSeq.toString()}, got ${row.seq.toString()}`,
      });
    }

    if (!buffersEqualOrBothNull(row.prevHash, expectedPrev)) {
      throw auditChainBrokenError({
        organizationId: args.organizationId,
        seq: row.seq,
        reason: "prevHash does not match the previous row's entryHash",
        expectedHashHex: expectedPrev === null ? "<null>" : expectedPrev.toString("hex"),
        actualHashHex: row.prevHash === null ? "<null>" : row.prevHash.toString("hex"),
      });
    }

    const recomputed = Buffer.from(
      computeAuditEntryHash({
        prevHash: row.prevHash,
        organizationId: row.organizationId,
        seq: row.seq,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        actorUserId: row.actorUserId,
        scope: row.scope,
        metadata: row.metadata,
        occurredAt: row.occurredAt,
      })
    );

    if (!recomputed.equals(row.entryHash)) {
      throw auditChainBrokenError({
        organizationId: args.organizationId,
        seq: row.seq,
        reason: "entryHash mismatch: row content does not match the stored hash (tamper)",
        expectedHashHex: recomputed.toString("hex"),
        actualHashHex: row.entryHash.toString("hex"),
      });
    }

    expectedPrev = row.entryHash;
    expectedSeq = row.seq + 1n;
    lastSeq = row.seq;
    lastHash = row.entryHash;
    verifiedRows += 1;
  }

  return {
    organizationId: args.organizationId,
    verifiedRows,
    firstSeq,
    lastSeq,
    lastHash,
  };
}

function buffersEqualOrBothNull(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.equals(b);
}
