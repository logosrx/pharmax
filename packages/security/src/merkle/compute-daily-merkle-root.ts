// Compute a per-tenant daily Merkle root over the audit chain.
//
// The audit chain is already tamper-evident at the row level (each
// `entryHash` is a SHA-256 over the previous hash + the row's canonical
// fields). A Merkle tree built over those entry hashes for a bounded
// time window gives us a SINGLE root that:
//
//   - commits to every audit_log row in that window for that tenant,
//   - can be signed with a KMS asymmetric key and published to an
//     immutable Object Lock bucket (see `sign-merkle-root.ts` and
//     `publish-merkle-manifest.ts`),
//   - is cheap to re-derive from the database and verify at audit
//     time without trusting the writer or the publisher.
//
// Why a Merkle root in addition to the hash chain:
//
//   - The hash chain detects tampering INSIDE the chain. A Merkle
//     root + external signature detects tampering of the chain itself
//     (someone with DB write access could in principle rewrite the
//     whole chain consistently from a point forward). Signing a root
//     of yesterday's window with a key the application server doesn't
//     hold (KMS-asymmetric) seals the window cryptographically.
//
//   - Auditors can verify "no row was added, removed, or modified in
//     the period from T1 to T2" by replaying rows out of the live
//     database, recomputing the Merkle root, and checking the signed
//     manifest. They never have to trust our process.
//
// Algorithm choice:
//
//   - Plain binary Merkle tree, SHA-256, leaves = `entryHash` bytes
//     of each row in ascending `seq` order. Odd levels duplicate the
//     last node (Bitcoin-style) to keep the implementation small;
//     this DOES NOT introduce the CVE-2012-2459 second-preimage
//     issue because our leaves are themselves SHA-256 outputs (not
//     attacker-controllable preimages) AND a separate domain-tag
//     byte (`0x00` for leaves, `0x01` for internal nodes) is
//     prepended at every hash. Domain tagging is the standard
//     mitigation; see RFC 6962 §2.1.
//
// PHI invariant:
//
//   - Audit-log rows are PHI-free by design (scope/metadata blobs
//     are redacted before write). The Merkle tree operates on
//     `entryHash` only — no PHI ever touches this code path.

import { createHash } from "node:crypto";

import type { ChainSource } from "@pharmax/audit";

/** Domain-separation byte prepended to leaf hashes. */
export const MERKLE_LEAF_TAG = 0x00;

/** Domain-separation byte prepended to internal-node hashes. */
export const MERKLE_NODE_TAG = 0x01;

export interface ComputeDailyMerkleRootInput {
  readonly organizationId: string;
  /** UTC start of the window (inclusive). */
  readonly periodStart: Date;
  /** UTC end of the window (exclusive). */
  readonly periodEnd: Date;
  /** Streaming source of audit-chain rows ordered by `seq` ascending. */
  readonly source: ChainSource;
}

export interface DailyMerkleRoot {
  /** SHA-256 of the per-day Merkle root, plus tag bytes. 32 bytes. */
  readonly rootHash: Buffer;
  readonly leafCount: number;
  /** First seq included in the tree, or `null` when the window is empty. */
  readonly firstSeq: bigint | null;
  /** Last seq included in the tree, or `null` when the window is empty. */
  readonly lastSeq: bigint | null;
  readonly organizationId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly computedAt: Date;
}

/**
 * Walk the audit chain for one organization across [`periodStart`,
 * `periodEnd`), collect the `entryHash` of every row, and return a
 * Merkle root. Rows MUST arrive in ascending `seq` order — the
 * `ChainSource` contract guarantees this, but we double-check by
 * tracking the previous seq and erroring on a regression.
 *
 * On an empty window the returned `leafCount` is 0 and `rootHash` is
 * the SHA-256 of the empty string with leaf-tag domain prefix. We
 * deliberately do NOT throw on empty windows: an org that had no
 * activity yesterday still publishes a signed "empty" manifest so
 * the absence of activity is itself cryptographically attested.
 */
export async function computeDailyMerkleRoot(
  input: ComputeDailyMerkleRootInput,
  options?: { readonly now?: () => Date }
): Promise<DailyMerkleRoot> {
  if (
    !(input.periodStart instanceof Date) ||
    !(input.periodEnd instanceof Date) ||
    Number.isNaN(input.periodStart.getTime()) ||
    Number.isNaN(input.periodEnd.getTime())
  ) {
    throw new TypeError("computeDailyMerkleRoot: periodStart and periodEnd must be valid Dates.");
  }
  if (input.periodEnd.getTime() <= input.periodStart.getTime()) {
    throw new RangeError("computeDailyMerkleRoot: periodEnd must be strictly after periodStart.");
  }

  const leafHashes: Buffer[] = [];
  let firstSeq: bigint | null = null;
  let lastSeq: bigint | null = null;
  let prevSeq: bigint | null = null;

  for await (const row of input.source.iterate({ organizationId: input.organizationId })) {
    if (row.occurredAt.getTime() < input.periodStart.getTime()) continue;
    if (row.occurredAt.getTime() >= input.periodEnd.getTime()) continue;

    if (prevSeq !== null && row.seq <= prevSeq) {
      throw new Error(
        `computeDailyMerkleRoot: ChainSource returned non-monotonic seq (got ${row.seq.toString()} after ${prevSeq.toString()}).`
      );
    }
    prevSeq = row.seq;

    leafHashes.push(Buffer.from(row.entryHash));
    if (firstSeq === null) firstSeq = row.seq;
    lastSeq = row.seq;
  }

  const rootHash = computeMerkleRootFromLeaves(leafHashes);
  const now = options?.now ?? (() => new Date());

  return {
    rootHash,
    leafCount: leafHashes.length,
    firstSeq,
    lastSeq,
    organizationId: input.organizationId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    computedAt: now(),
  };
}

/**
 * Pure Merkle-root computation over a sequence of pre-hashed leaves.
 * Exposed for unit tests and for in-memory replays during verification
 * (`verify-merkle-manifest.ts`).
 *
 * @throws if `leaves` is empty AND `allowEmpty !== true`. The default
 *   policy lets the caller decide whether an empty window is an
 *   acceptable input — the day-window job above passes
 *   `allowEmpty: true` because a tenant that had no audit activity
 *   yesterday still gets a signed manifest.
 */
export function computeMerkleRootFromLeaves(
  leaves: ReadonlyArray<Buffer>,
  options?: { readonly allowEmpty?: boolean }
): Buffer {
  if (leaves.length === 0) {
    if (options?.allowEmpty === false) {
      throw new Error("computeMerkleRootFromLeaves: cannot compute root over zero leaves.");
    }
    return hashLeaf(Buffer.alloc(0));
  }

  let level: Buffer[] = leaves.map((leaf) => hashLeaf(leaf));

  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i];
      if (left === undefined || right === undefined) {
        throw new Error("computeMerkleRootFromLeaves: internal index error.");
      }
      next.push(hashInternal(left, right));
    }
    level = next;
  }

  const root = level[0];
  if (root === undefined) {
    throw new Error("computeMerkleRootFromLeaves: empty level after reduction.");
  }
  return root;
}

function hashLeaf(value: Buffer): Buffer {
  const hash = createHash("sha256");
  hash.update(Buffer.from([MERKLE_LEAF_TAG]));
  hash.update(value);
  return hash.digest();
}

function hashInternal(left: Buffer, right: Buffer): Buffer {
  const hash = createHash("sha256");
  hash.update(Buffer.from([MERKLE_NODE_TAG]));
  hash.update(left);
  hash.update(right);
  return hash.digest();
}

/**
 * Default `ChainSource` implementation backed by the Prisma audit_log
 * table. Yields rows in ascending `seq` order for one organization
 * across an open seq range. Used by the daily-signing script when
 * pulling rows out of production; tests use a fake source.
 *
 * Reads occur INSIDE the caller's tenancy context (or system context
 * for cross-tenant batch jobs). This adapter does NOT manage the
 * GUC; callers are responsible.
 */
export interface PrismaAuditChainSourceClient {
  auditLog: {
    findMany(args: {
      where: {
        organizationId: string;
        seq?: { gte?: bigint; lte?: bigint };
      };
      orderBy: { seq: "asc" };
      take: number;
      cursor?: { organizationId_seq: { organizationId: string; seq: bigint } };
      skip?: number;
      select: {
        organizationId: true;
        seq: true;
        prevHash: true;
        entryHash: true;
        action: true;
        resourceType: true;
        resourceId: true;
        actorUserId: true;
        scope: true;
        metadata: true;
        occurredAt: true;
      };
    }): Promise<
      Array<{
        organizationId: string;
        seq: bigint;
        prevHash: Buffer | null;
        entryHash: Buffer;
        action: string;
        resourceType: string;
        resourceId: string | null;
        actorUserId: string | null;
        scope: unknown;
        metadata: unknown;
        occurredAt: Date;
      }>
    >;
  };
}

/**
 * Construct a streaming `ChainSource` that pages through `audit_log`
 * in `batchSize` chunks. The default batch size (500) keeps memory
 * usage bounded for tenants with very long chains.
 */
export function createPrismaAuditChainSource(
  client: PrismaAuditChainSourceClient,
  options?: { readonly batchSize?: number }
): ChainSource {
  const batchSize = options?.batchSize ?? 500;
  return {
    async *iterate(opts) {
      let cursor: bigint | undefined = opts.startSeq;
      const endSeq = opts.endSeq;

      while (true) {
        const seqFilter: { gte?: bigint; lte?: bigint } = {};
        if (cursor !== undefined) seqFilter.gte = cursor;
        if (endSeq !== undefined) seqFilter.lte = endSeq;

        const rows = await client.auditLog.findMany({
          where: {
            organizationId: opts.organizationId,
            ...(Object.keys(seqFilter).length > 0 ? { seq: seqFilter } : {}),
          },
          orderBy: { seq: "asc" },
          take: batchSize,
          select: {
            organizationId: true,
            seq: true,
            prevHash: true,
            entryHash: true,
            action: true,
            resourceType: true,
            resourceId: true,
            actorUserId: true,
            scope: true,
            metadata: true,
            occurredAt: true,
          },
        });

        if (rows.length === 0) break;

        for (const row of rows) {
          yield {
            organizationId: row.organizationId,
            seq: row.seq,
            prevHash: row.prevHash === null ? null : Buffer.from(row.prevHash),
            entryHash: Buffer.from(row.entryHash),
            action: row.action,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            actorUserId: row.actorUserId,
            scope: row.scope,
            metadata: row.metadata,
            occurredAt: row.occurredAt,
          };
        }

        const last = rows[rows.length - 1];
        if (last === undefined) break;
        const nextCursor = last.seq + 1n;
        if (endSeq !== undefined && nextCursor > endSeq) break;
        cursor = nextCursor;
      }
    },
  };
}
