import { describe, it, expect, beforeEach, vi } from "vitest";

import { computeAuditEntryHash } from "./encoder.js";
import { writeAuditLogInTx, type AuditChainTxClient } from "./writer.js";

interface RecordedCall {
  readonly kind: "advisoryLock" | "chainFindUnique" | "auditLogCreate" | "chainUpsert";
  readonly args: unknown;
}

interface FakeTx extends AuditChainTxClient {
  readonly recorded: RecordedCall[];
  setHead: (head: { latestHash: Buffer; latestSeq: bigint } | null) => void;
}

function buildFakeTx(): FakeTx {
  const recorded: RecordedCall[] = [];
  let head: { latestHash: Buffer; latestSeq: bigint } | null = null;
  let lastCreatedId = 0;

  const $executeRaw = vi.fn(
    async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      recorded.push({
        kind: "advisoryLock",
        args: { sql: template.join("?"), values: [...values] },
      });
      return 0;
    }
  );

  const auditLog = {
    create: vi.fn(async (args: { data: unknown }) => {
      recorded.push({ kind: "auditLogCreate", args: args.data });
      lastCreatedId += 1;
      return { id: `audit-${lastCreatedId}` };
    }),
  };

  const auditChainState = {
    findUnique: vi.fn(async (args: { where: { organizationId: string } }) => {
      recorded.push({ kind: "chainFindUnique", args });
      if (head === null) return null;
      return {
        organizationId: args.where.organizationId,
        latestHash: head.latestHash,
        latestSeq: head.latestSeq,
      };
    }),
    upsert: vi.fn(async (args: unknown) => {
      recorded.push({ kind: "chainUpsert", args });
      const a = args as {
        create: { latestHash: Buffer; latestSeq: bigint; organizationId: string };
      };
      head = { latestHash: a.create.latestHash, latestSeq: a.create.latestSeq };
      return {
        organizationId: a.create.organizationId,
        latestHash: a.create.latestHash,
        latestSeq: a.create.latestSeq,
      };
    }),
  };

  return {
    $executeRaw,
    auditLog,
    auditChainState,
    recorded,
    setHead: (h) => {
      head = h;
    },
  };
}

const ORG = "11111111-1111-7111-a111-111111111111";

const baseInput = (overrides: Partial<Parameters<typeof writeAuditLogInTx>[1]> = {}) => ({
  organizationId: ORG,
  actorUserId: "22222222-2222-7222-a222-222222222222",
  action: "pv1.approved",
  resourceType: "Order",
  resourceId: "33333333-3333-7333-a333-333333333333",
  scope: { siteId: "site-1" },
  metadata: { commandLogId: "log-1" },
  occurredAt: new Date("2026-05-22T19:00:00.000Z"),
  ...overrides,
});

let tx: FakeTx;

beforeEach(() => {
  tx = buildFakeTx();
});

describe("writeAuditLogInTx — genesis insert (no prior chain head)", () => {
  it("acquires per-tenant advisory lock BEFORE reading chain state", async () => {
    await writeAuditLogInTx(tx, baseInput());
    expect(tx.recorded[0]?.kind).toBe("advisoryLock");
    expect(tx.recorded[1]?.kind).toBe("chainFindUnique");
  });

  it("binds the organizationId as a parameter to the advisory lock SQL (injection-safe)", async () => {
    await writeAuditLogInTx(tx, baseInput());
    const lockCall = tx.recorded.find((r) => r.kind === "advisoryLock");
    const args = lockCall?.args as { sql: string; values: ReadonlyArray<unknown> };
    expect(args.sql).not.toContain(ORG);
    expect(args.values).toContain(ORG);
    expect(args.sql).toContain("pg_advisory_xact_lock");
  });

  it("inserts with seq=1 and prevHash=null on the genesis row", async () => {
    await writeAuditLogInTx(tx, baseInput());
    const create = tx.recorded.find((r) => r.kind === "auditLogCreate");
    const data = create?.args as { seq: bigint; prevHash: Buffer | null };
    expect(data.seq).toBe(1n);
    expect(data.prevHash).toBeNull();
  });

  it("returns the computed entryHash and seq", async () => {
    const out = await writeAuditLogInTx(tx, baseInput());
    expect(out.seq).toBe(1n);
    expect(out.entryHash.length).toBe(32);
  });

  it("entryHash matches a fresh computeAuditEntryHash over the same inputs", async () => {
    const input = baseInput();
    const out = await writeAuditLogInTx(tx, input);
    const expected = Buffer.from(
      computeAuditEntryHash({
        prevHash: null,
        organizationId: input.organizationId,
        seq: 1n,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        actorUserId: input.actorUserId,
        scope: input.scope,
        metadata: input.metadata,
        occurredAt: input.occurredAt,
      })
    );
    expect(out.entryHash.equals(expected)).toBe(true);
  });

  it("upserts audit_chain_state with the new head", async () => {
    const out = await writeAuditLogInTx(tx, baseInput());
    const upsert = tx.recorded.find((r) => r.kind === "chainUpsert");
    const args = upsert?.args as {
      where: { organizationId: string };
      create: { latestHash: Buffer; latestSeq: bigint };
    };
    expect(args.where.organizationId).toBe(ORG);
    expect(args.create.latestHash.equals(out.entryHash)).toBe(true);
    expect(args.create.latestSeq).toBe(1n);
  });
});

describe("writeAuditLogInTx — chained insert (prior head present)", () => {
  it("uses head.latestHash as the new row's prevHash", async () => {
    const head = Buffer.alloc(32).fill(0xab);
    tx.setHead({ latestHash: head, latestSeq: 7n });
    await writeAuditLogInTx(tx, baseInput());
    const create = tx.recorded.find((r) => r.kind === "auditLogCreate");
    const data = create?.args as { prevHash: Buffer | null };
    expect(data.prevHash?.equals(head)).toBe(true);
  });

  it("assigns seq = head.latestSeq + 1", async () => {
    tx.setHead({ latestHash: Buffer.alloc(32), latestSeq: 7n });
    const out = await writeAuditLogInTx(tx, baseInput());
    expect(out.seq).toBe(8n);
  });

  it("chains: two sequential calls produce row N's hash linked to row N-1's hash", async () => {
    const out1 = await writeAuditLogInTx(tx, baseInput({ action: "a1" }));
    const out2 = await writeAuditLogInTx(tx, baseInput({ action: "a2" }));
    // Reconstruct what the second row's prevHash should be: out1.entryHash.
    const create2 = tx.recorded.filter((r) => r.kind === "auditLogCreate")[1];
    const data2 = create2?.args as { prevHash: Buffer; seq: bigint };
    expect(data2.prevHash.equals(out1.entryHash)).toBe(true);
    expect(data2.seq).toBe(2n);
    expect(out2.seq).toBe(2n);
  });

  it("call order per insert is: lock → findUnique → audit_log.create → chain.upsert", async () => {
    await writeAuditLogInTx(tx, baseInput());
    const kinds = tx.recorded.map((r) => r.kind);
    expect(kinds).toEqual(["advisoryLock", "chainFindUnique", "auditLogCreate", "chainUpsert"]);
  });
});

describe("writeAuditLogInTx — input passthrough", () => {
  it("passes resourceId when provided", async () => {
    await writeAuditLogInTx(tx, baseInput({ resourceId: "rid-1" }));
    const data = (tx.recorded.find((r) => r.kind === "auditLogCreate")?.args ?? {}) as {
      resourceId?: string;
    };
    expect(data.resourceId).toBe("rid-1");
  });

  it("omits resourceId when not provided (Prisma optional-field convention)", async () => {
    const { resourceId: _omit, ...rest } = baseInput();
    void _omit;
    await writeAuditLogInTx(tx, rest);
    const data = (tx.recorded.find((r) => r.kind === "auditLogCreate")?.args ?? {}) as {
      resourceId?: string;
    };
    expect(data.resourceId).toBeUndefined();
  });

  it("passes actorUserId=null without crashing (system-context audit row)", async () => {
    await writeAuditLogInTx(tx, baseInput({ actorUserId: null }));
    const data = (tx.recorded.find((r) => r.kind === "auditLogCreate")?.args ?? {}) as {
      actorUserId: string | null;
    };
    expect(data.actorUserId).toBeNull();
  });
});
