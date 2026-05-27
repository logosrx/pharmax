import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AuditChainRow, ChainSource } from "@pharmax/audit";

import {
  MERKLE_LEAF_TAG,
  MERKLE_NODE_TAG,
  computeDailyMerkleRoot,
  computeMerkleRootFromLeaves,
} from "./compute-daily-merkle-root.js";

const ORG = "11111111-1111-7111-a111-111111111111";

function leafHash(value: Buffer): Buffer {
  const hash = createHash("sha256");
  hash.update(Buffer.from([MERKLE_LEAF_TAG]));
  hash.update(value);
  return hash.digest();
}

function internalHash(left: Buffer, right: Buffer): Buffer {
  const hash = createHash("sha256");
  hash.update(Buffer.from([MERKLE_NODE_TAG]));
  hash.update(left);
  hash.update(right);
  return hash.digest();
}

function buildFakeSource(rows: ReadonlyArray<AuditChainRow>): ChainSource {
  return {
    async *iterate(opts) {
      for (const row of rows) {
        if (row.organizationId !== opts.organizationId) continue;
        yield row;
      }
    },
  };
}

function makeRow(seq: bigint, occurredAt: Date, entryHashByte = 0xaa): AuditChainRow {
  const entryHash = Buffer.alloc(32, entryHashByte);
  return {
    organizationId: ORG,
    seq,
    prevHash: null,
    entryHash,
    action: `act.${seq.toString()}`,
    resourceType: "Order",
    resourceId: `rid-${seq.toString()}`,
    actorUserId: `user-${seq.toString()}`,
    scope: { siteId: "site-1" },
    metadata: { commandLogId: `clog-${seq.toString()}` },
    occurredAt,
  };
}

describe("computeMerkleRootFromLeaves", () => {
  it("rejects empty input when allowEmpty=false", () => {
    expect(() => computeMerkleRootFromLeaves([], { allowEmpty: false })).toThrow(
      /cannot compute root over zero leaves/
    );
  });

  it("returns the tagged-empty hash for an empty leaf set by default", () => {
    const expected = leafHash(Buffer.alloc(0));
    const got = computeMerkleRootFromLeaves([]);
    expect(got.equals(expected)).toBe(true);
  });

  it("hashes a single leaf with the leaf domain tag", () => {
    const leaf = Buffer.alloc(32, 0x11);
    const expected = leafHash(leaf);
    const got = computeMerkleRootFromLeaves([leaf]);
    expect(got.equals(expected)).toBe(true);
  });

  it("hashes two leaves into one internal node", () => {
    const leaves = [Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22)];
    const a = leafHash(leaves[0]!);
    const b = leafHash(leaves[1]!);
    const expected = internalHash(a, b);
    const got = computeMerkleRootFromLeaves(leaves);
    expect(got.equals(expected)).toBe(true);
  });

  it("handles odd leaf counts by promoting the last leaf (Bitcoin-style)", () => {
    const leaves = [Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22), Buffer.alloc(32, 0x33)];
    const a = leafHash(leaves[0]!);
    const b = leafHash(leaves[1]!);
    const c = leafHash(leaves[2]!);
    const ab = internalHash(a, b);
    const cc = internalHash(c, c);
    const expected = internalHash(ab, cc);
    const got = computeMerkleRootFromLeaves(leaves);
    expect(got.equals(expected)).toBe(true);
  });

  it("is deterministic across repeated invocations on a large input", () => {
    const leaves: Buffer[] = [];
    for (let i = 0; i < 257; i++) {
      leaves.push(Buffer.alloc(32, i % 256));
    }
    const first = computeMerkleRootFromLeaves(leaves);
    const second = computeMerkleRootFromLeaves(leaves);
    expect(first.equals(second)).toBe(true);
  });

  it("is sensitive to leaf ordering (swapping two leaves changes the root)", () => {
    const a = Buffer.alloc(32, 0x11);
    const b = Buffer.alloc(32, 0x22);
    const c = Buffer.alloc(32, 0x33);
    const rootAbc = computeMerkleRootFromLeaves([a, b, c]);
    const rootBac = computeMerkleRootFromLeaves([b, a, c]);
    expect(rootAbc.equals(rootBac)).toBe(false);
  });

  it("is sensitive to a single-byte change in any leaf", () => {
    const a = Buffer.alloc(32, 0x11);
    const b = Buffer.alloc(32, 0x22);
    const rootAb = computeMerkleRootFromLeaves([a, b]);
    const bPrime = Buffer.from(b);
    bPrime[0] = 0x99;
    const rootAbPrime = computeMerkleRootFromLeaves([a, bPrime]);
    expect(rootAb.equals(rootAbPrime)).toBe(false);
  });
});

describe("computeDailyMerkleRoot", () => {
  const periodStart = new Date(Date.UTC(2026, 4, 24, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(2026, 4, 25, 0, 0, 0));

  it("validates period bounds", async () => {
    await expect(
      computeDailyMerkleRoot({
        organizationId: ORG,
        periodStart: periodEnd,
        periodEnd: periodStart,
        source: buildFakeSource([]),
      })
    ).rejects.toThrow(/periodEnd must be strictly after periodStart/);
  });

  it("returns an empty-window root when the org had no activity in [start,end)", async () => {
    const beforeWindow = makeRow(1n, new Date(Date.UTC(2026, 4, 23, 12, 0, 0)));
    const afterWindow = makeRow(2n, new Date(Date.UTC(2026, 4, 25, 12, 0, 0)));
    const result = await computeDailyMerkleRoot({
      organizationId: ORG,
      periodStart,
      periodEnd,
      source: buildFakeSource([beforeWindow, afterWindow]),
    });
    expect(result.leafCount).toBe(0);
    expect(result.firstSeq).toBeNull();
    expect(result.lastSeq).toBeNull();
    expect(result.rootHash.equals(leafHash(Buffer.alloc(0)))).toBe(true);
  });

  it("computes a root over rows whose occurredAt falls in [start,end)", async () => {
    const row1 = makeRow(10n, new Date(Date.UTC(2026, 4, 24, 9, 0, 0)), 0x11);
    const row2 = makeRow(11n, new Date(Date.UTC(2026, 4, 24, 14, 0, 0)), 0x22);
    const result = await computeDailyMerkleRoot({
      organizationId: ORG,
      periodStart,
      periodEnd,
      source: buildFakeSource([row1, row2]),
    });
    expect(result.leafCount).toBe(2);
    expect(result.firstSeq).toBe(10n);
    expect(result.lastSeq).toBe(11n);
    const expected = computeMerkleRootFromLeaves([row1.entryHash, row2.entryHash]);
    expect(result.rootHash.equals(expected)).toBe(true);
  });

  it("rejects non-monotonic seq from the source (defense-in-depth check)", async () => {
    const row1 = makeRow(10n, new Date(Date.UTC(2026, 4, 24, 1, 0, 0)));
    const row2 = makeRow(9n, new Date(Date.UTC(2026, 4, 24, 2, 0, 0)));
    await expect(
      computeDailyMerkleRoot({
        organizationId: ORG,
        periodStart,
        periodEnd,
        source: buildFakeSource([row1, row2]),
      })
    ).rejects.toThrow(/non-monotonic seq/);
  });
});
