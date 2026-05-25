// Internal test helpers — NOT exported from index.ts.
//
// We construct a hand-rolled fake PrismaClient because spinning up
// a real one would couple every executor test to a live DB. The
// fake records every call and lets tests assert the exact 20-step
// shape (command_log written → tx opened → audit/outbox written →
// tx committed → command_log updated).

import { vi } from "vitest";

import { clock as clockNs, logger as loggerNs } from "@pharmax/platform-core";

import type { CommandBusConfiguration } from "./configure.js";

export interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

export interface FakePrisma {
  readonly calls: FakeCall[];
  /** Set the row that `idempotencyKey.findUnique` returns. */
  setIdempotencyHit: (row: Record<string, unknown> | null) => void;
  /**
   * If set, the next `$transaction` callback throws this error
   * AFTER the handler runs and AFTER any in-tx writes. Use to
   * simulate a commit failure.
   */
  throwOnCommit: (err: Error | null) => void;
  /**
   * Set the row that `auditChainState.findUnique` returns. NULL
   * (the default) exercises the genesis-insert path; a non-null
   * value exercises the chained-insert path with the given
   * latestHash/latestSeq as prevHash/seq-1.
   */
  setAuditChainHead: (head: { latestHash: Buffer; latestSeq: bigint } | null) => void;
  /**
   * Configure rows returned by `$queryRaw` SELECT … FOR UPDATE on
   * the `order` table. Tests for `defineCommand`'s lockTarget step
   * call this to simulate a hit vs. a miss.
   */
  setOrderRowForLock: (
    row: {
      readonly id: string;
      readonly organizationId: string;
      readonly clinicId: string;
      readonly siteId: string;
      readonly currentStatus: string;
      readonly version: number;
      readonly workflowPolicyId: string;
      readonly workflowPolicyVersion: number;
    } | null
  ) => void;
  /**
   * Configure the row returned by `workflowPolicy.findUnique`.
   * NULL exercises the missing-policy path; non-ACTIVE status
   * exercises the inactive-policy path.
   */
  setWorkflowPolicyRow: (
    row: {
      readonly id: string;
      readonly code: string;
      readonly version: number;
      readonly status: string;
    } | null
  ) => void;
  /**
   * Configure the head of `order_event` for `orderEvent.findFirst`.
   * NULL is the brand-new-order case (next seq = 1); a numeric
   * value lets tests assert resume-from-checkpoint sequencing.
   */
  setOrderEventHead: (head: { readonly sequenceNumber: number } | null) => void;
  /**
   * Configure the count returned by `order.updateMany` for version
   * CAS attempts. Default 1 (CAS hit). Set to 0 to simulate a CAS
   * miss; the factory should surface this as ConflictError.
   */
  setOrderUpdateManyCount: (count: number) => void;
  /**
   * If set, the `command.handle` callback is replaced by this
   * function for the next `$transaction` call. Test code sets a
   * real handler; this is only for simulating handler-thrown
   * errors from inside the tx.
   */
  // (Not used in the fake itself — exposed for clarity.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly client: any;
}

export function buildFakePrisma(): FakePrisma {
  const calls: FakeCall[] = [];
  let idempotencyHit: Record<string, unknown> | null = null;
  let commitError: Error | null = null;
  // The variables below are mutated by the `setXxx` setters returned
  // at the bottom of this function and READ inside the per-table
  // fakes declared further down. They MUST stay `let` (not `const`)
  // so the setters can reassign them; the prior ESLint baseline
  // false-flagged them as never-reassigned because the closures
  // hadn't been wired up yet — now they have.
  let orderRowForLock: {
    id: string;
    organizationId: string;
    clinicId: string;
    siteId: string;
    currentStatus: string;
    version: number;
    workflowPolicyId: string;
    workflowPolicyVersion: number;
  } | null = null;
  let workflowPolicyRow: {
    id: string;
    code: string;
    version: number;
    status: string;
  } | null = null;
  let orderEventHead: { sequenceNumber: number } | null = null;
  let orderUpdateManyCount = 1;

  const record = (table: string, op: string) =>
    vi.fn(async (args: unknown) => {
      calls.push({ table, op, args });
      if (table === "idempotencyKey" && op === "findUnique") {
        return idempotencyHit;
      }
      if (table === "order" && op === "updateMany") {
        return { count: orderUpdateManyCount };
      }
      return { count: 1 };
    });

  // $executeRaw on the tx client. Prisma's signature is
  // `(template: TemplateStringsArray, ...values: unknown[]) => Promise<number>`.
  // We record the joined template + values under
  // `table=$executeRaw, op=<most-specific SQL token>` so tests can
  // assert (a) the call happened at all, and (b) what SQL primitive
  // was invoked (e.g. `set_config` for RLS GUCs).
  //
  // We check for `set_config` BEFORE falling back to the leading
  // verb — otherwise `SELECT set_config(...)` would record as `select`,
  // which loses the RLS-specific signal we want to assert against.
  const recordExecuteRaw = vi.fn(
    async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      const joined = template.join("?");
      let op: string;
      if (/\bset_config\b/i.test(joined)) {
        op = "set_config";
      } else if (/\bpg_advisory_xact_lock\b/i.test(joined)) {
        // Audit chain writer acquires its per-tenant advisory lock
        // via `SELECT pg_advisory_xact_lock(audit_chain_lock_key(...))`.
        // Bucketing it as "advisory_lock" lets ordering tests assert
        // that the lock is taken BEFORE the audit insert.
        op = "advisory_lock";
      } else {
        const verbMatch = /\b(select|insert|update|delete|alter|create)\b/i.exec(joined);
        op = (verbMatch?.[1] ?? "raw").toLowerCase();
      }
      calls.push({
        table: "$executeRaw",
        op,
        args: { sql: joined, values: [...values] },
      });
      return 0;
    }
  );

  // auditChainState.findUnique returns null by default (genesis
  // insert path); tests that want to assert on the chained path
  // can override via setAuditChainHead below.
  let auditChainHead: { latestHash: Buffer; latestSeq: bigint } | null = null;
  const auditChainFindUnique = vi.fn(async (args: { where: { organizationId: string } }) => {
    calls.push({ table: "auditChainState", op: "findUnique", args });
    if (auditChainHead === null) return null;
    return {
      organizationId: args.where.organizationId,
      latestHash: auditChainHead.latestHash,
      latestSeq: auditChainHead.latestSeq,
    };
  });
  const auditChainUpsert = vi.fn(async (args: unknown) => {
    calls.push({ table: "auditChainState", op: "upsert", args });
    return { ok: true };
  });

  // $queryRaw on the tx client. The defineCommand factory uses
  // this to issue `SELECT … FOR UPDATE` on the `order` table.
  // Tests configure the locked row via `setOrderRowForLock`. We
  // detect the SELECT shape and return an array (Prisma's
  // $queryRaw returns rows[]); unknown shapes return [] so the
  // command surfaces `ORDER_NOT_FOUND` cleanly in tests.
  const recordQueryRaw = vi.fn(
    async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      const joined = template.join("?");
      let op: string;
      if (/\bFROM\s+"?order"?\b/i.test(joined) && /\bFOR\s+UPDATE\b/i.test(joined)) {
        op = "select_for_update_order";
      } else {
        const verbMatch = /\b(select|insert|update|delete)\b/i.exec(joined);
        op = (verbMatch?.[1] ?? "raw").toLowerCase();
      }
      calls.push({
        table: "$queryRaw",
        op,
        args: { sql: joined, values: [...values] },
      });
      if (op === "select_for_update_order") {
        return orderRowForLock === null ? [] : [orderRowForLock];
      }
      return [];
    }
  );

  const workflowPolicyFindUnique = vi.fn(async (args: unknown) => {
    calls.push({ table: "workflowPolicy", op: "findUnique", args });
    return workflowPolicyRow;
  });

  const orderEventFindFirst = vi.fn(async (args: unknown) => {
    calls.push({ table: "orderEvent", op: "findFirst", args });
    return orderEventHead;
  });

  const orderEventCreate = record("orderEvent", "create");

  const orderUpdateMany = record("order", "updateMany");

  const txClient = {
    commandLog: { create: record("commandLog", "create") },
    auditLog: { create: record("auditLog", "create") },
    auditChainState: {
      findUnique: auditChainFindUnique,
      upsert: auditChainUpsert,
    },
    eventOutbox: { createMany: record("eventOutbox", "createMany") },
    idempotencyKey: { create: record("idempotencyKey", "create") },
    workflowPolicy: { findUnique: workflowPolicyFindUnique },
    order: { updateMany: orderUpdateMany },
    orderEvent: {
      findFirst: orderEventFindFirst,
      create: orderEventCreate,
    },
    $executeRaw: recordExecuteRaw,
    $queryRaw: recordQueryRaw,
  };

  const client = {
    commandLog: {
      create: record("commandLog", "create"),
      update: record("commandLog", "update"),
    },
    idempotencyKey: {
      findUnique: record("idempotencyKey", "findUnique"),
    },
    $transaction: vi.fn(async (fn: (tx: typeof txClient) => Promise<unknown>) => {
      const out = await fn(txClient);
      if (commitError !== null) {
        const err = commitError;
        commitError = null;
        throw err;
      }
      return out;
    }),
  };

  return {
    calls,
    setIdempotencyHit: (row) => {
      idempotencyHit = row;
    },
    throwOnCommit: (err) => {
      commitError = err;
    },
    setAuditChainHead: (head) => {
      auditChainHead = head;
    },
    setOrderRowForLock: (row) => {
      orderRowForLock = row === null ? null : { ...row };
    },
    setWorkflowPolicyRow: (row) => {
      workflowPolicyRow = row === null ? null : { ...row };
    },
    setOrderEventHead: (head) => {
      orderEventHead = head === null ? null : { ...head };
    },
    setOrderUpdateManyCount: (count) => {
      orderUpdateManyCount = count;
    },
    client,
  };
}

export function buildFakeConfig(prisma: FakePrisma): CommandBusConfiguration {
  return {
    prisma: prisma.client as unknown as CommandBusConfiguration["prisma"],
    clock: clockNs.createFrozenClock(new Date("2026-05-21T00:00:00.000Z")),
    logger: loggerNs.noopLogger,
  };
}

export function callsTo(prisma: FakePrisma, table: string, op?: string): FakeCall[] {
  return prisma.calls.filter((c) => c.table === table && (op === undefined || c.op === op));
}
