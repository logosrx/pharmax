// Contract tests for the compound batch lifecycle transitions.
//
// Invariants under test:
//   1. Each command only accepts its FROM status, and the write is a
//      compare-and-swap on that status — a batch that moved underneath
//      us produces BATCH_INVALID_TRANSITION, never a silent overwrite.
//   2. Rejection stamps the reason code on the row (schema CHECK
//      backstops it) and validates the code against the reason list.
//   3. Promoting a batch to DISPENSING demotes the incumbent back to
//      RELEASED in the same transaction.
//   4. A batch past its Beyond-Use Date can never become the
//      dispensing batch, released or not.
//   5. Release/reject require inventory.batch.release; the
//      operational moves require inventory.batch.transition. A tech
//      grant cannot release.
//   6. Every edge emits one status_changed event carrying from/to.

import { afterEach, describe, expect, it, vi } from "vitest";

import { RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  RejectCompoundBatch,
  ReleaseCompoundBatch,
  SendCompoundBatchToTesting,
  StartDispensingCompoundBatch,
} from "./compound-batch-transitions.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PRODUCT_ID = "44444444-4444-4444-8444-444444444444";
const BATCH_ID = "55555555-5555-4555-8555-555555555555";
const INCUMBENT_ID = "66666666-6666-4666-8666-666666666666";

const NOW = new Date("2027-04-10T12:00:00.000Z");

const transitionGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.INVENTORY_BATCH_TRANSITION]),
  },
];

const releaseGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.INVENTORY_BATCH_RELEASE]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    siteId: SITE_ID,
    productId: PRODUCT_ID,
    batchNumber: "PHX-T30-1-040327",
    status: "COMPOUNDED",
    beyondUseDate: new Date("2027-07-02T00:00:00.000Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// Fake Prisma
// ---------------------------------------------------------------------

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakePrismaOptions {
  /** Rows returned by successive compoundBatch.findFirst calls. The
   *  last entry repeats once exhausted, so a CAS-miss reload sees the
   *  same row unless a second entry is supplied. */
  batches?: Array<Record<string, unknown> | null>;
  /** Row returned by the incumbent-dispensing lookup. */
  incumbent?: { id: string; batchNumber: string } | null;
  /** updateMany matched-row count (0 simulates a lost CAS race). */
  updateCount?: number;
}

function buildFakePrisma(opts: FakePrismaOptions = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const batches = opts.batches ?? [batchRow()];
  let findFirstIndex = 0;

  const tx = {
    compoundBatch: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundBatch", op: "findFirst", args });
        const where = (args as { where: Record<string, unknown> }).where;
        // The incumbent lookup is the one filtering on status.
        if (where["status"] === "DISPENSING") return opts.incumbent ?? null;
        const row = batches[Math.min(findFirstIndex, batches.length - 1)] ?? null;
        findFirstIndex += 1;
        return row;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundBatch", op: "updateMany", args });
        const where = (args as { where: Record<string, unknown> }).where;
        // The incumbent demote always lands; only the subject CAS is
        // subject to the simulated race.
        if (where["id"] === INCUMBENT_ID) return { count: 1 };
        return { count: opts.updateCount ?? 1 };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cmd-log-1" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "findUnique", args });
        return null;
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "audit-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "findUnique", args });
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "upsert", args });
        const data = args as {
          where: { organizationId: string };
          create: { latestHash: Buffer; latestSeq: bigint };
        };
        return {
          organizationId: data.where.organizationId,
          latestHash: data.create.latestHash,
          latestSeq: data.create.latestSeq,
        };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: (args as { data: unknown[] }).data.length };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "create", args });
        return { id: "idem-1" };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
    },
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        const joined = template.join("?");
        const op = /\bset_config\b/i.test(joined)
          ? "set_config"
          : /\bpg_advisory_xact_lock\b/i.test(joined)
            ? "advisory_lock"
            : "raw";
        calls.push({ table: "$executeRaw", op, args: { sql: joined, values: [...values] } });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cmd-log-pretx" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { id: "cmd-log-pretx" };
      }),
    },
    idempotencyKey: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function outboxPayloads(calls: FakeCall[]): Array<Record<string, unknown>> {
  return callsOf(calls, "eventOutbox", "createMany").flatMap(
    (c) => (c.args as { data: Array<Record<string, unknown>> }).data
  );
}

function wireBusAndRbac(client: unknown, grants: ReadonlyArray<ResolvedGrant>): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(NOW),
    logger: logger.noopLogger,
  });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
}

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

// ---------------------------------------------------------------------
// SendCompoundBatchToTesting
// ---------------------------------------------------------------------

describe("SendCompoundBatchToTesting", () => {
  it("CAS-moves a COMPOUNDED batch to TESTING and emits the status_changed event", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, transitionGrants);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(SendCompoundBatchToTesting, { batchId: BATCH_ID }, { idempotencyKey: "t-1" })
    );

    expect(out).toMatchObject({
      batchId: BATCH_ID,
      batchNumber: "PHX-T30-1-040327",
      fromStatus: "COMPOUNDED",
      toStatus: "TESTING",
    });

    // The write is guarded on the expected FROM status.
    const update = callsOf(fake.calls, "compoundBatch", "updateMany")[0]?.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(update.where).toMatchObject({
      id: BATCH_ID,
      organizationId: ORG_ID,
      status: "COMPOUNDED",
    });
    expect(update.data).toMatchObject({ status: "TESTING", statusChangedAt: NOW });

    const events = outboxPayloads(fake.calls);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "inventory.compound_batch.status_changed.v1",
    });
    expect(events[0]?.["payload"]).toMatchObject({
      organizationId: ORG_ID,
      batchId: BATCH_ID,
      fromStatus: "COMPOUNDED",
      toStatus: "TESTING",
      changedByUserId: USER_ID,
    });
  });

  it("refuses a batch that is already TESTING", async () => {
    const fake = buildFakePrisma({ batches: [batchRow({ status: "TESTING" })] });
    wireBusAndRbac(fake.client, transitionGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          SendCompoundBatchToTesting,
          { batchId: BATCH_ID },
          { idempotencyKey: "t-already" }
        )
      )
    ).rejects.toMatchObject({
      code: "BATCH_INVALID_TRANSITION",
      metadata: { currentStatus: "TESTING", expectedStatus: "COMPOUNDED" },
    });

    expect(callsOf(fake.calls, "compoundBatch", "updateMany")).toHaveLength(0);
  });

  it("turns a lost CAS race into BATCH_INVALID_TRANSITION naming the winner's status", async () => {
    // Load sees COMPOUNDED; the CAS matches nothing because a
    // concurrent command already moved it to TESTING.
    const fake = buildFakePrisma({
      batches: [batchRow(), batchRow({ status: "TESTING" })],
      updateCount: 0,
    });
    wireBusAndRbac(fake.client, transitionGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          SendCompoundBatchToTesting,
          { batchId: BATCH_ID },
          { idempotencyKey: "t-race" }
        )
      )
    ).rejects.toMatchObject({
      code: "BATCH_INVALID_TRANSITION",
      metadata: { currentStatus: "TESTING" },
    });
  });

  it("refuses an unknown batch", async () => {
    const fake = buildFakePrisma({ batches: [null] });
    wireBusAndRbac(fake.client, transitionGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          SendCompoundBatchToTesting,
          { batchId: BATCH_ID },
          { idempotencyKey: "t-missing" }
        )
      )
    ).rejects.toMatchObject({ code: "BATCH_NOT_FOUND" });
  });

  it("denies a user holding only the release grant", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, releaseGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          SendCompoundBatchToTesting,
          { batchId: BATCH_ID },
          { idempotencyKey: "t-rbac" }
        )
      )
    ).rejects.toMatchObject({ httpStatus: 403 });
  });
});

// ---------------------------------------------------------------------
// ReleaseCompoundBatch
// ---------------------------------------------------------------------

describe("ReleaseCompoundBatch", () => {
  it("moves a TESTING batch to RELEASED and records the lab reference in audit", async () => {
    const fake = buildFakePrisma({ batches: [batchRow({ status: "TESTING" })] });
    wireBusAndRbac(fake.client, releaseGrants);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        ReleaseCompoundBatch,
        { batchId: BATCH_ID, labReference: "CoA-99182" },
        { idempotencyKey: "r-1" }
      )
    );

    expect(out).toMatchObject({ fromStatus: "TESTING", toStatus: "RELEASED" });

    const audit = (
      callsOf(fake.calls, "auditLog", "create")[0]?.args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("inventory.compound_batch.released");
    expect(audit.metadata).toMatchObject({ labReference: "CoA-99182" });
  });

  it("refuses to release a batch that never went to testing", async () => {
    const fake = buildFakePrisma({ batches: [batchRow({ status: "COMPOUNDED" })] });
    wireBusAndRbac(fake.client, releaseGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(ReleaseCompoundBatch, { batchId: BATCH_ID }, { idempotencyKey: "r-early" })
      )
    ).rejects.toMatchObject({
      code: "BATCH_INVALID_TRANSITION",
      metadata: { currentStatus: "COMPOUNDED", expectedStatus: "TESTING" },
    });

    expect(callsOf(fake.calls, "compoundBatch", "updateMany")).toHaveLength(0);
  });

  it("denies a technician holding only the transition grant — release is a quality decision", async () => {
    const fake = buildFakePrisma({ batches: [batchRow({ status: "TESTING" })] });
    wireBusAndRbac(fake.client, transitionGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(ReleaseCompoundBatch, { batchId: BATCH_ID }, { idempotencyKey: "r-rbac" })
      )
    ).rejects.toMatchObject({ httpStatus: 403 });

    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// RejectCompoundBatch
// ---------------------------------------------------------------------

describe("RejectCompoundBatch", () => {
  it("stamps the reason code on the row and carries it in the event", async () => {
    const fake = buildFakePrisma({ batches: [batchRow({ status: "TESTING" })] });
    wireBusAndRbac(fake.client, releaseGrants);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RejectCompoundBatch,
        { batchId: BATCH_ID, reasonCode: "STERILITY_FAILURE", note: "growth on day 7" },
        { idempotencyKey: "x-1" }
      )
    );

    expect(out).toMatchObject({ fromStatus: "TESTING", toStatus: "REJECTED" });

    const update = callsOf(fake.calls, "compoundBatch", "updateMany")[0]?.args as {
      data: Record<string, unknown>;
    };
    expect(update.data).toMatchObject({
      status: "REJECTED",
      rejectionReasonCode: "STERILITY_FAILURE",
    });

    expect(outboxPayloads(fake.calls)[0]?.["payload"]).toMatchObject({
      toStatus: "REJECTED",
      reasonCode: "STERILITY_FAILURE",
    });
  });

  it("refuses an unrecognized reason code before any write", async () => {
    const fake = buildFakePrisma({ batches: [batchRow({ status: "TESTING" })] });
    wireBusAndRbac(fake.client, releaseGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RejectCompoundBatch,
          { batchId: BATCH_ID, reasonCode: "BECAUSE_I_SAID_SO" } as never,
          { idempotencyKey: "x-bad-reason" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });

    expect(callsOf(fake.calls, "compoundBatch", "updateMany")).toHaveLength(0);
  });

  it("refuses to reject an already-REJECTED batch (terminal)", async () => {
    const fake = buildFakePrisma({
      batches: [batchRow({ status: "REJECTED", rejectionReasonCode: "CONTAMINATION" })],
    });
    wireBusAndRbac(fake.client, releaseGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RejectCompoundBatch,
          { batchId: BATCH_ID, reasonCode: "CONTAMINATION" },
          { idempotencyKey: "x-terminal" }
        )
      )
    ).rejects.toMatchObject({
      code: "BATCH_INVALID_TRANSITION",
      metadata: { currentStatus: "REJECTED" },
    });
  });
});

// ---------------------------------------------------------------------
// StartDispensingCompoundBatch
// ---------------------------------------------------------------------

describe("StartDispensingCompoundBatch", () => {
  it("promotes a RELEASED batch and demotes the incumbent in the same transaction", async () => {
    const fake = buildFakePrisma({
      batches: [batchRow({ status: "RELEASED" })],
      incumbent: { id: INCUMBENT_ID, batchNumber: "PHX-T30-1-040127" },
    });
    wireBusAndRbac(fake.client, transitionGrants);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(StartDispensingCompoundBatch, { batchId: BATCH_ID }, { idempotencyKey: "d-1" })
    );

    expect(out).toMatchObject({ fromStatus: "RELEASED", toStatus: "DISPENSING" });

    const updates = callsOf(fake.calls, "compoundBatch", "updateMany").map(
      (c) => c.args as { where: Record<string, unknown>; data: Record<string, unknown> }
    );
    expect(updates).toHaveLength(2);
    // Demote first, then promote — both guarded on their FROM status.
    expect(updates[0]?.where).toMatchObject({ id: INCUMBENT_ID, status: "DISPENSING" });
    expect(updates[0]?.data).toMatchObject({ status: "RELEASED" });
    expect(updates[1]?.where).toMatchObject({ id: BATCH_ID, status: "RELEASED" });
    expect(updates[1]?.data).toMatchObject({ status: "DISPENSING" });

    expect(outboxPayloads(fake.calls)[0]?.["payload"]).toMatchObject({
      toStatus: "DISPENSING",
      demotedBatchId: INCUMBENT_ID,
    });
  });

  it("promotes without a demote when nothing is dispensing yet", async () => {
    const fake = buildFakePrisma({
      batches: [batchRow({ status: "RELEASED" })],
      incumbent: null,
    });
    wireBusAndRbac(fake.client, transitionGrants);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        StartDispensingCompoundBatch,
        { batchId: BATCH_ID },
        { idempotencyKey: "d-first" }
      )
    );

    expect(callsOf(fake.calls, "compoundBatch", "updateMany")).toHaveLength(1);
    const payload = outboxPayloads(fake.calls)[0]?.["payload"] as Record<string, unknown>;
    expect(payload["demotedBatchId"]).toBeUndefined();
  });

  it("refuses a batch past its Beyond-Use Date even though it is RELEASED", async () => {
    const fake = buildFakePrisma({
      batches: [
        batchRow({
          status: "RELEASED",
          // One day before the frozen clock.
          beyondUseDate: new Date("2027-04-09T00:00:00.000Z"),
        }),
      ],
    });
    wireBusAndRbac(fake.client, transitionGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          StartDispensingCompoundBatch,
          { batchId: BATCH_ID },
          { idempotencyKey: "d-bud" }
        )
      )
    ).rejects.toMatchObject({
      code: "BATCH_PAST_BUD",
      metadata: { beyondUseDate: "2027-04-09" },
    });

    expect(callsOf(fake.calls, "compoundBatch", "updateMany")).toHaveLength(0);
  });

  it("allows a batch whose BUD is today (the BUD day is still dispensable)", async () => {
    const fake = buildFakePrisma({
      batches: [
        batchRow({ status: "RELEASED", beyondUseDate: new Date("2027-04-10T00:00:00.000Z") }),
      ],
    });
    wireBusAndRbac(fake.client, transitionGrants);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        StartDispensingCompoundBatch,
        { batchId: BATCH_ID },
        { idempotencyKey: "d-bud-today" }
      )
    );

    expect(out.toStatus).toBe("DISPENSING");
  });

  it("refuses a batch that has not been released", async () => {
    const fake = buildFakePrisma({ batches: [batchRow({ status: "TESTING" })] });
    wireBusAndRbac(fake.client, transitionGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          StartDispensingCompoundBatch,
          { batchId: BATCH_ID },
          { idempotencyKey: "d-untested" }
        )
      )
    ).rejects.toMatchObject({
      code: "BATCH_INVALID_TRANSITION",
      metadata: { currentStatus: "TESTING", expectedStatus: "RELEASED" },
    });
  });
});
