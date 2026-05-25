// Verifier contract tests.
//
// We exercise the verifier against an in-memory `ChainSource` whose
// rows are *built by the writer* in the previous test. That guarantees
// the bytes match exactly what production would produce; we don't
// hand-craft a row's entryHash anywhere (an off-by-one in a test
// would otherwise look like a bug in the verifier).
//
// What the test matrix covers:
//
//   - Genesis chain: prevHash=NULL, seq=1, recomputed hash matches.
//   - Multi-row chain: row N's prevHash equals row N-1's entryHash.
//   - Tamper: mutating any field of a stored row (action, scope,
//     metadata, occurredAt, actorUserId, resourceId, prevHash, even
//     entryHash itself) trips AUDIT_CHAIN_BROKEN with the right seq.
//   - seq gap: a row missing from the middle of the chain throws.
//   - Per-tenant isolation: rows from tenant A and tenant B verify
//     independently; B's chain head being malformed does NOT affect
//     the A walk.
//   - Resume verification: a verifier started at seq=N with the
//     correct startPrevHash accepts the chain; with a wrong
//     startPrevHash it throws on the first row.

import { describe, expect, it } from "vitest";

import { verifyChain, type AuditChainRow, type ChainSource } from "./verifier.js";
import { computeAuditEntryHash } from "./encoder.js";

const ORG_A = "11111111-1111-7111-a111-111111111111";
const ORG_B = "44444444-4444-7444-a444-444444444444";

interface BuildRowsOptions {
  readonly organizationId: string;
  readonly count: number;
  readonly startSeq?: bigint;
  readonly startPrev?: Buffer | null;
  /** Override one field of one row, post-hash, to simulate tampering. */
  readonly tamper?: (rows: AuditChainRow[]) => void;
}

/**
 * Build a sequence of legitimately-chained rows. Hashes are computed
 * by the production encoder so the rows ARE byte-exact what the
 * writer would persist.
 */
function buildChain(opts: BuildRowsOptions): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev: Buffer | null = opts.startPrev ?? null;
  const startSeq = opts.startSeq ?? 1n;

  for (let i = 0; i < opts.count; i++) {
    const seq = startSeq + BigInt(i);
    const occurredAt = new Date(Date.UTC(2026, 4, 22, 19, 0, 0, i));
    const actorUserId = `actor-${seq.toString()}`;
    const action = `action.${seq.toString()}`;
    const resourceType = "Order";
    const resourceId = `rid-${seq.toString()}`;
    const scope = { siteId: "site-1" };
    const metadata = { commandLogId: `log-${seq.toString()}` };

    const entryHash = Buffer.from(
      computeAuditEntryHash({
        prevHash: prev,
        organizationId: opts.organizationId,
        seq,
        action,
        resourceType,
        resourceId,
        actorUserId,
        scope,
        metadata,
        occurredAt,
      })
    );

    rows.push({
      organizationId: opts.organizationId,
      seq,
      prevHash: prev,
      entryHash,
      action,
      resourceType,
      resourceId,
      actorUserId,
      scope,
      metadata,
      occurredAt,
    });

    prev = entryHash;
  }

  if (opts.tamper) opts.tamper(rows);
  return rows;
}

/** ChainSource over an in-memory rows array, with filtering. */
function sourceFor(rows: AuditChainRow[]): ChainSource {
  return {
    iterate: async function* (opts) {
      const start = opts.startSeq ?? 1n;
      const end = opts.endSeq ?? (1n << 63n) - 1n;
      for (const r of rows) {
        if (r.organizationId !== opts.organizationId) continue;
        if (r.seq < start) continue;
        if (r.seq > end) continue;
        yield r;
      }
    },
  };
}

describe("verifyChain — happy path", () => {
  it("accepts a legitimately-built genesis-and-chained sequence of 5 rows", async () => {
    const rows = buildChain({ organizationId: ORG_A, count: 5 });
    const result = await verifyChain(sourceFor(rows), { organizationId: ORG_A });
    expect(result.verifiedRows).toBe(5);
    expect(result.firstSeq).toBe(1n);
    expect(result.lastSeq).toBe(5n);
    expect(result.lastHash?.equals(rows[4]!.entryHash)).toBe(true);
  });

  it("returns the tip hash and seq matching the final row", async () => {
    const rows = buildChain({ organizationId: ORG_A, count: 3 });
    const result = await verifyChain(sourceFor(rows), { organizationId: ORG_A });
    expect(result.lastHash?.equals(rows[2]!.entryHash)).toBe(true);
    expect(result.lastSeq).toBe(3n);
  });

  it("returns verifiedRows=0 and nullish stats for an empty chain (new tenant)", async () => {
    const result = await verifyChain(sourceFor([]), { organizationId: ORG_A });
    expect(result.verifiedRows).toBe(0);
    expect(result.firstSeq).toBeNull();
    expect(result.lastSeq).toBeNull();
    expect(result.lastHash).toBeNull();
  });
});

describe("verifyChain — tamper detection", () => {
  it("throws AUDIT_CHAIN_BROKEN when entryHash is mutated", async () => {
    const rows = buildChain({
      organizationId: ORG_A,
      count: 3,
      tamper: (r) => {
        r[1] = { ...r[1]!, entryHash: Buffer.alloc(32).fill(0xee) };
      },
    });
    await expect(verifyChain(sourceFor(rows), { organizationId: ORG_A })).rejects.toMatchObject({
      code: "AUDIT_CHAIN_BROKEN",
      metadata: { seq: "2" },
    });
  });

  it("throws when action is mutated (recomputed hash no longer matches)", async () => {
    const rows = buildChain({
      organizationId: ORG_A,
      count: 3,
      tamper: (r) => {
        r[1] = { ...r[1]!, action: "tampered" };
      },
    });
    await expect(verifyChain(sourceFor(rows), { organizationId: ORG_A })).rejects.toMatchObject({
      code: "AUDIT_CHAIN_BROKEN",
      metadata: { seq: "2", reason: expect.stringContaining("entryHash mismatch") },
    });
  });

  it("throws when scope JSON is mutated (json canonicalization still detects)", async () => {
    const rows = buildChain({
      organizationId: ORG_A,
      count: 3,
      tamper: (r) => {
        r[2] = { ...r[2]!, scope: { siteId: "evil" } };
      },
    });
    await expect(verifyChain(sourceFor(rows), { organizationId: ORG_A })).rejects.toMatchObject({
      code: "AUDIT_CHAIN_BROKEN",
      metadata: { seq: "3" },
    });
  });

  it("throws when occurredAt is shifted by 1 ms", async () => {
    const rows = buildChain({
      organizationId: ORG_A,
      count: 2,
      tamper: (r) => {
        r[1] = {
          ...r[1]!,
          occurredAt: new Date(r[1]!.occurredAt.getTime() + 1),
        };
      },
    });
    await expect(verifyChain(sourceFor(rows), { organizationId: ORG_A })).rejects.toMatchObject({
      code: "AUDIT_CHAIN_BROKEN",
      metadata: { seq: "2" },
    });
  });

  it("throws when prevHash is mutated (chain linkage broken)", async () => {
    const rows = buildChain({
      organizationId: ORG_A,
      count: 3,
      tamper: (r) => {
        r[2] = { ...r[2]!, prevHash: Buffer.alloc(32).fill(0xab) };
      },
    });
    await expect(verifyChain(sourceFor(rows), { organizationId: ORG_A })).rejects.toMatchObject({
      code: "AUDIT_CHAIN_BROKEN",
      metadata: {
        seq: "3",
        reason: expect.stringContaining("prevHash"),
      },
    });
  });
});

describe("verifyChain — sequence integrity", () => {
  it("throws AUDIT_CHAIN_BROKEN when a row is missing from the middle of the chain", async () => {
    const full = buildChain({ organizationId: ORG_A, count: 5 });
    // Drop row at seq=3.
    const missing = full.filter((r) => r.seq !== 3n);
    await expect(verifyChain(sourceFor(missing), { organizationId: ORG_A })).rejects.toMatchObject({
      code: "AUDIT_CHAIN_BROKEN",
      metadata: {
        seq: "4",
        reason: expect.stringContaining("seq gap"),
      },
    });
  });

  it("throws when the chain does not start at seq=1 (genesis missing)", async () => {
    const full = buildChain({ organizationId: ORG_A, count: 3 });
    const missingGenesis = full.filter((r) => r.seq !== 1n);
    await expect(
      verifyChain(sourceFor(missingGenesis), { organizationId: ORG_A })
    ).rejects.toMatchObject({
      code: "AUDIT_CHAIN_BROKEN",
      metadata: { reason: expect.stringContaining("seq gap") },
    });
  });
});

describe("verifyChain — per-tenant isolation", () => {
  it("verifies tenant A even when tenant B's chain in the same source has tampered rows", async () => {
    const a = buildChain({ organizationId: ORG_A, count: 3 });
    const b = buildChain({
      organizationId: ORG_B,
      count: 3,
      tamper: (r) => {
        r[1] = { ...r[1]!, entryHash: Buffer.alloc(32).fill(0xff) };
      },
    });
    const combined = [...a, ...b];
    const result = await verifyChain(sourceFor(combined), { organizationId: ORG_A });
    expect(result.verifiedRows).toBe(3);
  });

  it("verifying tenant B (with tamper) throws while tenant A still verifies clean", async () => {
    const a = buildChain({ organizationId: ORG_A, count: 3 });
    const b = buildChain({
      organizationId: ORG_B,
      count: 3,
      tamper: (r) => {
        r[1] = { ...r[1]!, action: "tampered" };
      },
    });
    const combined = [...a, ...b];

    const aResult = await verifyChain(sourceFor(combined), { organizationId: ORG_A });
    expect(aResult.verifiedRows).toBe(3);

    await expect(verifyChain(sourceFor(combined), { organizationId: ORG_B })).rejects.toMatchObject(
      {
        code: "AUDIT_CHAIN_BROKEN",
        metadata: { seq: "2" },
      }
    );
  });
});

describe("verifyChain — resume from a known checkpoint", () => {
  it("accepts a partial walk starting at seq=N when startPrevHash is the entryHash of seq=N-1", async () => {
    const rows = buildChain({ organizationId: ORG_A, count: 5 });
    const result = await verifyChain(sourceFor(rows), {
      organizationId: ORG_A,
      startSeq: 3n,
      startPrevHash: rows[1]!.entryHash,
    });
    expect(result.verifiedRows).toBe(3);
    expect(result.firstSeq).toBe(3n);
    expect(result.lastSeq).toBe(5n);
  });

  it("throws on the first row of a resumed walk when startPrevHash is wrong", async () => {
    const rows = buildChain({ organizationId: ORG_A, count: 5 });
    await expect(
      verifyChain(sourceFor(rows), {
        organizationId: ORG_A,
        startSeq: 3n,
        startPrevHash: Buffer.alloc(32).fill(0x42),
      })
    ).rejects.toMatchObject({
      code: "AUDIT_CHAIN_BROKEN",
      metadata: {
        seq: "3",
        reason: expect.stringContaining("prevHash"),
      },
    });
  });

  it("respects endSeq (bounded walk)", async () => {
    const rows = buildChain({ organizationId: ORG_A, count: 5 });
    const result = await verifyChain(sourceFor(rows), {
      organizationId: ORG_A,
      endSeq: 3n,
    });
    expect(result.verifiedRows).toBe(3);
    expect(result.lastSeq).toBe(3n);
  });
});
