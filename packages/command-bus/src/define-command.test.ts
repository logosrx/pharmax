// defineCommand contract — the declarative factory.
//
// `defineCommand` is the syntactic sugar over `executeCommand` that
// codifies the inside-the-tx workflow choreography (row lock →
// policy load → SoD → exec → version CAS → order_event writeback).
// The factory output is a plain `Command<TInput, TOutput>`; the
// existing 20-step orchestration is unchanged.
//
// These tests are black-box: each one constructs a synthetic
// command via `defineCommand`, dispatches it through
// `executeCommand`, and asserts on the fake Prisma's call log to
// verify the factory wove the additional steps in the right order
// at the right time.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { RoleScope } from "@pharmax/database";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { configureCommandBus, resetCommandBusConfigurationForTests } from "./configure.js";
import { defineCommand, type DefineCommandSpec } from "./define-command.js";
import { executeCommand } from "./execute-command.js";
import { buildFakeConfig, buildFakePrisma, callsTo, type FakePrisma } from "./test-helpers.js";

const ORDER_ID = "aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
const POLICY_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-7ccc-cccc-cccccccccccc";

const allWorkflowGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([
      PERMISSIONS.ORDERS_CREATE,
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.PV1_APPROVE,
      PERMISSIONS.FINAL_APPROVE,
      PERMISSIONS.TYPING_COMPLETE,
    ]),
  },
];

function ctxFor(overrides: Record<string, unknown> = {}): TenancyContext {
  const base: Record<string, unknown> = {
    organizationId: "org-1",
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return buildTenancyContext(base as unknown as Parameters<typeof buildTenancyContext>[0]);
}

let prisma: FakePrisma;

beforeEach(() => {
  prisma = buildFakePrisma();
  configureCommandBus(buildFakeConfig(prisma));
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: "org-1", userId: USER_ID, grants: allWorkflowGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

// ---------------------------------------------------------------------------
// Output / spec preservation
// ---------------------------------------------------------------------------

describe("defineCommand — produces a Command<TInput, TOutput>", () => {
  it("propagates name, permission, requiresWorkstation, redactFields", () => {
    const cmd = defineCommand({
      name: "TestPing",
      inputSchema: z.object({ ping: z.string() }),
      permission: PERMISSIONS.ORDERS_CREATE,
      requiresWorkstation: true,
      redactFields: ["secret"],
      exec: async () => ({
        output: { ok: true },
        audit: { action: "x", resourceType: "Order" },
        emits: [],
      }),
    });
    expect(cmd.name).toBe("TestPing");
    expect(cmd.permission).toBe(PERMISSIONS.ORDERS_CREATE);
    expect(cmd.requiresWorkstation).toBe(true);
    expect(cmd.redactFields).toEqual(["secret"]);
    expect(typeof cmd.handle).toBe("function");
  });

  it("requiresWorkstation defaults to absent (not false) when omitted", () => {
    const cmd = defineCommand({
      name: "NoWs",
      inputSchema: z.object({}),
      permission: null,
      exec: async () => ({
        output: {},
        audit: { action: "x", resourceType: "Order" },
        emits: [],
      }),
    });
    // Faithful pass-through: when the spec omits the flag, the
    // synthesized Command also omits it. This matches how
    // hand-written commands declare the absence.
    expect(cmd.requiresWorkstation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

describe("defineCommand — spec validation", () => {
  it("throws DEFINE_COMMAND_CONFIG_INVALID when sodRules is set without lockTarget", () => {
    expect(() =>
      defineCommand({
        name: "BadSpec1",
        inputSchema: z.object({ orderId: z.string() }),
        permission: PERMISSIONS.PV1_APPROVE,
        sodRules: [
          {
            attempted: PERMISSIONS.PV1_APPROVE,
            against: "target",
            translate: () => null,
          },
        ],
        exec: async () => ({
          output: {},
          audit: { action: "x", resourceType: "Order" },
          emits: [],
        }),
      })
    ).toThrowError(expect.objectContaining({ code: "DEFINE_COMMAND_CONFIG_INVALID" }));
  });

  it("throws DEFINE_COMMAND_CONFIG_INVALID when loadPolicy:from=target without lockTarget", () => {
    expect(() =>
      defineCommand({
        name: "BadSpec2",
        inputSchema: z.object({}),
        permission: null,
        loadPolicy: { from: "target" },
        exec: async () => ({
          output: {},
          audit: { action: "x", resourceType: "Order" },
          emits: [],
        }),
      })
    ).toThrowError(expect.objectContaining({ code: "DEFINE_COMMAND_CONFIG_INVALID" }));
  });
});

// ---------------------------------------------------------------------------
// Row lock
// ---------------------------------------------------------------------------

describe("defineCommand — lockTarget", () => {
  function makeLockingCommand(): DefineCommandSpec<{ orderId: string }, { ok: boolean }> {
    return {
      name: "LockingCmd",
      inputSchema: z.object({ orderId: z.string().uuid() }),
      permission: PERMISSIONS.ORDERS_READ,
      lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) },
      exec: async ({ target }) => {
        if (target === undefined) throw new Error("expected target");
        return {
          output: { ok: true },
          audit: {
            action: "ping",
            resourceType: "Order",
            resourceId: target.id,
            metadata: { lockedVersion: target.version },
          },
          emits: [],
          targetOrderId: target.id,
        };
      },
    };
  }

  it("issues SELECT … FOR UPDATE inside the tx BEFORE audit_log and BEFORE the order_event writeback", async () => {
    prisma.setOrderRowForLock({
      id: ORDER_ID,
      organizationId: "org-1",
      clinicId: "clinic-1",
      siteId: "site-1",
      currentStatus: "RECEIVED",
      version: 3,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        defineCommand(makeLockingCommand()),
        { orderId: ORDER_ID },
        { idempotencyKey: "lock-1" }
      )
    );

    const lockCalls = callsTo(prisma, "$queryRaw", "select_for_update_order");
    expect(lockCalls).toHaveLength(1);
    // The SQL must bind id and organizationId as PARAMETERS, not
    // interpolated. The fake records them under args.values.
    expect((lockCalls[0]?.args as { values: ReadonlyArray<unknown> }).values).toEqual(
      expect.arrayContaining([ORDER_ID, "org-1"])
    );

    const lockIdx = prisma.calls.indexOf(lockCalls[0]!);

    // Tenancy session GUC fires first.
    const firstGucIdx = prisma.calls.indexOf(callsTo(prisma, "$executeRaw", "set_config")[0]!);
    expect(firstGucIdx).toBeLessThan(lockIdx);

    // Audit + order_event writes come AFTER the lock.
    const auditIdx = prisma.calls.indexOf(callsTo(prisma, "auditLog", "create")[0]!);
    expect(lockIdx).toBeLessThan(auditIdx);
  });

  it("throws ORDER_NOT_FOUND when no row matches (and writes no order_event / no audit)", async () => {
    prisma.setOrderRowForLock(null);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          defineCommand(makeLockingCommand()),
          { orderId: ORDER_ID },
          { idempotencyKey: "miss-1" }
        )
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });

    expect(callsTo(prisma, "orderEvent", "create")).toHaveLength(0);
    expect(callsTo(prisma, "auditLog", "create")).toHaveLength(0);
    expect(callsTo(prisma, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("passes the locked target columns through to exec", async () => {
    prisma.setOrderRowForLock({
      id: ORDER_ID,
      organizationId: "org-1",
      clinicId: "clinic-1",
      siteId: "site-1",
      currentStatus: "PV1_IN_PROGRESS",
      version: 7,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 2,
    });

    let seen: unknown = null;
    const cmd = defineCommand({
      name: "Inspect",
      inputSchema: z.object({ orderId: z.string().uuid() }),
      permission: PERMISSIONS.ORDERS_READ,
      lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) },
      exec: async ({ target }) => {
        seen = target;
        return {
          output: {},
          audit: { action: "x", resourceType: "Order", resourceId: ORDER_ID },
          emits: [],
          targetOrderId: ORDER_ID,
        };
      },
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId: ORDER_ID }, { idempotencyKey: "inspect-1" })
    );

    expect(seen).toEqual({
      id: ORDER_ID,
      organizationId: "org-1",
      clinicId: "clinic-1",
      siteId: "site-1",
      currentStatus: "PV1_IN_PROGRESS",
      version: 7,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Policy load
// ---------------------------------------------------------------------------

describe("defineCommand — loadPolicy", () => {
  it("fetches by (organizationId, code, version) and passes the row to exec", async () => {
    prisma.setWorkflowPolicyRow({
      id: POLICY_ID,
      code: "order.standard",
      version: 1,
      status: "ACTIVE",
    });

    let observedPolicy: unknown = null;
    const cmd = defineCommand({
      name: "PolicyByCode",
      inputSchema: z.object({}),
      permission: PERMISSIONS.ORDERS_CREATE,
      loadPolicy: { code: "order.standard", version: 1 },
      exec: async ({ policy }) => {
        observedPolicy = policy;
        return {
          output: {},
          audit: { action: "x", resourceType: "Order" },
          emits: [],
        };
      },
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, {}, { idempotencyKey: "policy-1" })
    );

    const findCall = callsTo(prisma, "workflowPolicy", "findUnique")[0];
    expect(findCall).toBeDefined();
    expect((findCall!.args as { where: unknown }).where).toEqual({
      organizationId_code_version: {
        organizationId: "org-1",
        code: "order.standard",
        version: 1,
      },
    });
    expect(observedPolicy).toEqual({ id: POLICY_ID, code: "order.standard", version: 1 });
  });

  it("throws WORKFLOW_POLICY_NOT_FOUND when the policy row is missing", async () => {
    prisma.setWorkflowPolicyRow(null);

    const cmd = defineCommand({
      name: "PolicyMissing",
      inputSchema: z.object({}),
      permission: PERMISSIONS.ORDERS_CREATE,
      loadPolicy: { code: "order.standard", version: 1 },
      exec: async () => ({
        output: {},
        audit: { action: "x", resourceType: "Order" },
        emits: [],
      }),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(cmd, {}, { idempotencyKey: "policy-miss" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
  });

  it("throws WORKFLOW_POLICY_INACTIVE when the policy row exists but is not ACTIVE", async () => {
    prisma.setWorkflowPolicyRow({
      id: POLICY_ID,
      code: "order.standard",
      version: 1,
      status: "RETIRED",
    });

    const cmd = defineCommand({
      name: "PolicyInactive",
      inputSchema: z.object({}),
      permission: PERMISSIONS.ORDERS_CREATE,
      loadPolicy: { code: "order.standard", version: 1 },
      exec: async () => ({
        output: {},
        audit: { action: "x", resourceType: "Order" },
        emits: [],
      }),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(cmd, {}, { idempotencyKey: "policy-retired" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
  });

  it("from: 'target' reads policyId+version from the locked row", async () => {
    prisma.setOrderRowForLock({
      id: ORDER_ID,
      organizationId: "org-1",
      clinicId: "clinic-1",
      siteId: "site-1",
      currentStatus: "RECEIVED",
      version: 0,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
    });
    prisma.setWorkflowPolicyRow({
      id: POLICY_ID,
      code: "order.standard",
      version: 1,
      status: "ACTIVE",
    });

    const cmd = defineCommand({
      name: "PolicyFromTarget",
      inputSchema: z.object({ orderId: z.string().uuid() }),
      permission: PERMISSIONS.ORDERS_READ,
      lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) },
      loadPolicy: { from: "target" },
      exec: async ({ policy }) => ({
        output: { policyId: policy?.id ?? null },
        audit: { action: "x", resourceType: "Order", resourceId: ORDER_ID },
        emits: [],
        targetOrderId: ORDER_ID,
      }),
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId: ORDER_ID }, { idempotencyKey: "ftarget-1" })
    );

    const findCall = callsTo(prisma, "workflowPolicy", "findUnique")[0];
    expect((findCall!.args as { where: { id: string } }).where).toEqual({ id: POLICY_ID });
  });
});

// ---------------------------------------------------------------------------
// Version CAS
// ---------------------------------------------------------------------------

describe("defineCommand — bumpVersion CAS", () => {
  function makeBumpCommand(): DefineCommandSpec<{ orderId: string }, { ok: boolean }> {
    return {
      name: "BumpVer",
      inputSchema: z.object({ orderId: z.string().uuid() }),
      permission: PERMISSIONS.ORDERS_READ,
      lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) },
      exec: async ({ target }) => ({
        output: { ok: true },
        audit: { action: "x", resourceType: "Order", resourceId: ORDER_ID },
        emits: [],
        targetOrderId: ORDER_ID,
        bumpVersion: { from: target!.version, to: target!.version + 1 },
      }),
    };
  }

  it("issues a CAS update where: { id, version: from }, succeeds when count=1", async () => {
    prisma.setOrderRowForLock({
      id: ORDER_ID,
      organizationId: "org-1",
      clinicId: "clinic-1",
      siteId: "site-1",
      currentStatus: "RECEIVED",
      version: 3,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
    });
    prisma.setOrderUpdateManyCount(1);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        defineCommand(makeBumpCommand()),
        { orderId: ORDER_ID },
        { idempotencyKey: "bump-1" }
      )
    );

    const updates = callsTo(prisma, "order", "updateMany");
    expect(updates).toHaveLength(1);
    expect((updates[0]!.args as { where: unknown }).where).toEqual({
      id: ORDER_ID,
      organizationId: "org-1",
      version: 3,
    });
    expect((updates[0]!.args as { data: unknown }).data).toEqual({ version: 4 });
  });

  it("throws ORDER_VERSION_MISMATCH when CAS count=0 (concurrent writer beat us)", async () => {
    prisma.setOrderRowForLock({
      id: ORDER_ID,
      organizationId: "org-1",
      clinicId: "clinic-1",
      siteId: "site-1",
      currentStatus: "RECEIVED",
      version: 3,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
    });
    prisma.setOrderUpdateManyCount(0);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          defineCommand(makeBumpCommand()),
          { orderId: ORDER_ID },
          { idempotencyKey: "bump-miss" }
        )
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });
  });
});

// ---------------------------------------------------------------------------
// order_event writeback
// ---------------------------------------------------------------------------

describe("defineCommand — order_event writeback", () => {
  it("writes one order_event per emit AND one outbox row per emit, with monotonic seq from head+1", async () => {
    prisma.setOrderEventHead({ sequenceNumber: 4 });

    const cmd = defineCommand({
      name: "MultiEmit",
      inputSchema: z.object({}),
      permission: PERMISSIONS.ORDERS_CREATE,
      exec: async () => ({
        output: {},
        audit: { action: "multi.executed", resourceType: "Order", resourceId: ORDER_ID },
        emits: [
          {
            eventType: "order.a.v1",
            aggregateType: "Order",
            aggregateId: ORDER_ID,
            payload: { which: "a" },
          },
          {
            eventType: "order.b.v1",
            aggregateType: "Order",
            aggregateId: ORDER_ID,
            payload: { which: "b" },
          },
        ],
        targetOrderId: ORDER_ID,
      }),
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, {}, { idempotencyKey: "multi-1" })
    );

    const creates = callsTo(prisma, "orderEvent", "create");
    expect(creates).toHaveLength(2);

    const first = (creates[0]!.args as { data: Record<string, unknown> }).data;
    const second = (creates[1]!.args as { data: Record<string, unknown> }).data;
    expect(first).toMatchObject({
      orderId: ORDER_ID,
      organizationId: "org-1",
      eventType: "order.a.v1",
      sequenceNumber: 5,
      actorUserId: USER_ID,
    });
    expect(second).toMatchObject({
      eventType: "order.b.v1",
      sequenceNumber: 6,
    });

    // Both events are also queued on the outbox (the bus writes
    // them via createMany).
    const outboxCalls = callsTo(prisma, "eventOutbox", "createMany");
    expect(outboxCalls).toHaveLength(1);
    const outboxRows = (outboxCalls[0]!.args as { data: Array<{ eventType: string }> }).data;
    expect(outboxRows.map((r) => r.eventType)).toEqual(["order.a.v1", "order.b.v1"]);
  });

  it("brand-new order (head=null) gets seq=1 for the first emit", async () => {
    prisma.setOrderEventHead(null);

    const cmd = defineCommand({
      name: "FirstEmit",
      inputSchema: z.object({}),
      permission: PERMISSIONS.ORDERS_CREATE,
      exec: async () => ({
        output: {},
        audit: { action: "first", resourceType: "Order", resourceId: ORDER_ID },
        emits: [
          {
            eventType: "order.received.v1",
            aggregateType: "Order",
            aggregateId: ORDER_ID,
            payload: {},
          },
        ],
        targetOrderId: ORDER_ID,
      }),
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, {}, { idempotencyKey: "first-1" })
    );

    const create = callsTo(prisma, "orderEvent", "create")[0]!;
    expect((create.args as { data: { sequenceNumber: number } }).data.sequenceNumber).toBe(1);
  });

  it("skips order_event writes when targetOrderId is undefined (non-order commands)", async () => {
    const cmd = defineCommand({
      name: "NonOrder",
      inputSchema: z.object({}),
      permission: null,
      exec: async () => ({
        output: {},
        audit: { action: "x", resourceType: "Bucket" },
        emits: [
          {
            eventType: "bucket.created.v1",
            aggregateType: "Bucket",
            aggregateId: "bkt-1",
            payload: {},
          },
        ],
      }),
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, {}, { idempotencyKey: "no-target" })
    );

    expect(callsTo(prisma, "orderEvent", "create")).toHaveLength(0);
    // Outbox still fired (the bus does that).
    expect(callsTo(prisma, "eventOutbox", "createMany")).toHaveLength(1);
  });

  it("skips order_event writes when emits is empty (read-only-ish commands)", async () => {
    const cmd = defineCommand({
      name: "NoEmits",
      inputSchema: z.object({}),
      permission: PERMISSIONS.ORDERS_READ,
      exec: async () => ({
        output: {},
        audit: { action: "read", resourceType: "Order", resourceId: ORDER_ID },
        emits: [],
        targetOrderId: ORDER_ID,
      }),
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, {}, { idempotencyKey: "no-emit" })
    );

    expect(callsTo(prisma, "orderEvent", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Saga compensation
// ---------------------------------------------------------------------------

describe("defineCommand — saga compensation", () => {
  it("registered undos fire in LIFO order when exec throws", async () => {
    const undoOrder: string[] = [];

    const cmd = defineCommand({
      name: "SagaFail",
      inputSchema: z.object({}),
      permission: PERMISSIONS.ORDERS_CREATE,
      exec: async ({ saga }) => {
        saga.step({ name: "step-A", undo: async () => void undoOrder.push("A") });
        saga.step({ name: "step-B", undo: async () => void undoOrder.push("B") });
        saga.step({ name: "step-C", undo: async () => void undoOrder.push("C") });
        throw new Error("boom");
      },
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(executeCommand(cmd, {}, { idempotencyKey: "saga-fail" })).rejects.toThrow(
        /boom/
      );
    });

    // C registered last, so undoes first (LIFO).
    expect(undoOrder).toEqual(["C", "B", "A"]);
  });

  it("happy path does NOT invoke any registered undos", async () => {
    const undoOrder: string[] = [];

    const cmd = defineCommand({
      name: "SagaOk",
      inputSchema: z.object({}),
      permission: PERMISSIONS.ORDERS_CREATE,
      exec: async ({ saga }) => {
        saga.step({ name: "step-A", undo: async () => void undoOrder.push("A") });
        return {
          output: {},
          audit: { action: "ok", resourceType: "Order", resourceId: ORDER_ID },
          emits: [],
        };
      },
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, {}, { idempotencyKey: "saga-ok" })
    );

    expect(undoOrder).toEqual([]);
  });

  it("a throwing undo does NOT mask the original exec error", async () => {
    const cmd = defineCommand({
      name: "SagaUndoThrows",
      inputSchema: z.object({}),
      permission: PERMISSIONS.ORDERS_CREATE,
      exec: async ({ saga }) => {
        saga.step({
          name: "broken-undo",
          undo: async () => {
            throw new Error("undo-blew-up");
          },
        });
        throw new Error("original-failure");
      },
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(executeCommand(cmd, {}, { idempotencyKey: "saga-undo-throws" })).rejects.toThrow(
        /original-failure/
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Step ordering — the integration assertion
// ---------------------------------------------------------------------------

describe("defineCommand — canonical step ordering", () => {
  it("session GUC → row lock → policy load → orderEvent.findFirst → orderEvent.create → CAS → audit_log", async () => {
    prisma.setOrderRowForLock({
      id: ORDER_ID,
      organizationId: "org-1",
      clinicId: "clinic-1",
      siteId: "site-1",
      currentStatus: "RECEIVED",
      version: 0,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
    });
    prisma.setWorkflowPolicyRow({
      id: POLICY_ID,
      code: "order.standard",
      version: 1,
      status: "ACTIVE",
    });
    prisma.setOrderEventHead({ sequenceNumber: 0 });

    const cmd = defineCommand({
      name: "FullOrdering",
      inputSchema: z.object({ orderId: z.string().uuid() }),
      permission: PERMISSIONS.ORDERS_READ,
      lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) },
      loadPolicy: { from: "target" },
      exec: async ({ target }) => ({
        output: {},
        audit: { action: "ordering", resourceType: "Order", resourceId: ORDER_ID },
        emits: [
          {
            eventType: "order.ping.v1",
            aggregateType: "Order",
            aggregateId: ORDER_ID,
            payload: {},
          },
        ],
        targetOrderId: ORDER_ID,
        bumpVersion: { from: target!.version, to: target!.version + 1 },
      }),
    });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId: ORDER_ID }, { idempotencyKey: "ordering-1" })
    );

    const idxOf = (table: string, op: string): number => {
      const c = callsTo(prisma, table, op)[0];
      if (c === undefined) throw new Error(`missing ${table}.${op}`);
      return prisma.calls.indexOf(c);
    };

    const gucIdx = idxOf("$executeRaw", "set_config");
    const lockIdx = idxOf("$queryRaw", "select_for_update_order");
    const policyIdx = idxOf("workflowPolicy", "findUnique");
    const oeHeadIdx = idxOf("orderEvent", "findFirst");
    const oeCreateIdx = idxOf("orderEvent", "create");
    const casIdx = idxOf("order", "updateMany");
    const auditIdx = idxOf("auditLog", "create");
    const outboxIdx = idxOf("eventOutbox", "createMany");

    expect(gucIdx).toBeLessThan(lockIdx);
    expect(lockIdx).toBeLessThan(policyIdx);
    expect(policyIdx).toBeLessThan(casIdx);
    expect(casIdx).toBeLessThan(oeHeadIdx);
    expect(oeHeadIdx).toBeLessThan(oeCreateIdx);
    expect(oeCreateIdx).toBeLessThan(auditIdx);
    expect(auditIdx).toBeLessThan(outboxIdx);
  });
});
