// StartFill contract tests.
//
// Mirrors the `start-pv1.test.ts` pattern: hand-rolled Prisma fake
// per file so the suite is DB-free and the fake exposes exactly the
// tables this command touches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope, OrderStageIntervalKind } from "@pharmax/database";
import { createOrderStageIntervalTxStub } from "@pharmax/sla/test-utils";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { StartFill } from "./start-fill.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const FILL_BUCKET_ID = "00000000-0000-4000-8000-0000000000cc";

const orgWideFillStartGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.FILL_START]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

const validInput = () => ({ orderId: ORDER_ID });

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  lockedRow?: { currentStatus: string; version: number } | null;
  policy?: { code: string; version: number; status: string } | null;
  fillBucketFound?: boolean;
  orderUpdateManyCount?: number;
  orderEventHead?: { sequenceNumber: number } | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "PV1_APPROVED_READY_FOR_FILL", version: 4 }
      : overrides.lockedRow;
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const fillBucketFound = overrides.fillBucketFound ?? true;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead =
    "orderEventHead" in overrides ? (overrides.orderEventHead ?? null) : { sequenceNumber: 5 };

  const tx = {
    orderStageInterval: createOrderStageIntervalTxStub(
      (table, op, args) => calls.push({ table, op, args }),
      OrderStageIntervalKind.WAIT_BEFORE_FILL
    ),
    workflowPolicy: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "findUnique", args });
        return policy === null ? null : { id: POLICY_ID, ...policy };
      }),
    },
    order: {
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "update", args });
        return { id: ORDER_ID };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: orderUpdateManyCount };
      }),
    },
    bucket: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findFirst", args });
        return fillBucketFound ? { id: FILL_BUCKET_ID } : null;
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-6" };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-1" };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "findUnique", args });
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "upsert", args });
        return {
          organizationId: ORG_ID,
          latestHash: Buffer.alloc(32),
          latestSeq: 1n,
        };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "create", args });
        return { ok: true };
      }),
    },
    $queryRaw: vi.fn(async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      const joined = template.join("?");
      let op: string;
      if (/\bFROM\s+"?order"?\b/i.test(joined) && /\bFOR\s+UPDATE\b/i.test(joined)) {
        op = "select_for_update_order";
      } else {
        const verbMatch = /\b(select|insert|update|delete)\b/i.exec(joined);
        op = (verbMatch?.[1] ?? "raw").toLowerCase();
      }
      calls.push({ table: "$queryRaw", op, args: { sql: joined, values: [...values] } });
      if (op === "select_for_update_order") {
        return lockedRow === null
          ? []
          : [
              {
                id: ORDER_ID,
                organizationId: ORG_ID,
                clinicId: CLINIC_ID,
                siteId: SITE_ID,
                currentStatus: lockedRow.currentStatus,
                version: lockedRow.version,
                workflowPolicyId: POLICY_ID,
                workflowPolicyVersion: 1,
              },
            ];
      }
      return [];
    }),
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
        return { id: "cl-pre" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
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

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-23T14:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: orgWideFillStartGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("StartFill — happy path", () => {
  it("returns expected output and writes order.update + factory CAS + order_event + audit + outbox", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFill, validInput(), { idempotencyKey: "start-fill-1" })
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      currentStatus: "FILL_IN_PROGRESS",
      version: 5,
      transitionId: "wf.v1.start_fill",
    });

    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(1);

    const policyCalls = callsOf(fake.calls, "workflowPolicy", "findUnique");
    expect(policyCalls).toHaveLength(1);
    expect((policyCalls[0]!.args as { where: unknown }).where).toEqual({ id: POLICY_ID });

    const bucketCall = callsOf(fake.calls, "bucket", "findFirst")[0];
    expect((bucketCall!.args as { where: Record<string, unknown> }).where).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      code: "FILL",
    });

    const updateCalls = callsOf(fake.calls, "order", "update");
    expect(updateCalls).toHaveLength(1);
    const updateArgs = updateCalls[0]!.args as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateArgs.where).toEqual({ id: ORDER_ID });
    expect(updateArgs.data).toMatchObject({
      currentStatus: "FILL_IN_PROGRESS",
      currentBucketId: FILL_BUCKET_ID,
      currentAssigneeUserId: USER_ID,
    });
    expect(updateArgs.data["version"]).toBeUndefined();

    const oeCreate = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreate).toHaveLength(1);
    const oeData = (oeCreate[0]!.args as { data: Record<string, unknown> }).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.fill.started.v1",
      sequenceNumber: 6,
      actorUserId: USER_ID,
    });

    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });

  it("explicitly sets currentAssigneeUserId to the fill tech (ApprovePV1 cleared assignee)", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFill, validInput(), { idempotencyKey: "start-fill-claim" })
    );

    const updateArgs = (
      callsOf(fake.calls, "order", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(updateArgs).toHaveProperty("currentAssigneeUserId", USER_ID);
  });

  it("seq=1 when the order has no prior events (defensive)", async () => {
    const fake = buildPrismaFake({ orderEventHead: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFill, validInput(), { idempotencyKey: "start-fill-2" })
    );

    const oeData = (
      callsOf(fake.calls, "orderEvent", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(oeData["sequenceNumber"]).toBe(1);
  });

  it("emits order.fill.started.v1 outbox payload with scope + transition + ISO timestamp", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFill, validInput(), { idempotencyKey: "start-fill-3" })
    );

    const outboxCall = callsOf(fake.calls, "eventOutbox", "createMany")[0];
    const rows = (outboxCall!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.fill.started.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(rows[0]?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      fillTechUserId: USER_ID,
      bucketId: FILL_BUCKET_ID,
      transitionId: "wf.v1.start_fill",
      fromState: "PV1_APPROVED_READY_FOR_FILL",
      toState: "FILL_IN_PROGRESS",
      occurredAt: "2026-05-23T14:00:00.000Z",
    });
  });

  it("audit metadata records transition + policy + bucket WITHOUT PHI", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFill, validInput(), { idempotencyKey: "start-fill-4" })
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(auditData).toMatchObject({
      action: "order.fill.started",
      resourceType: "Order",
      resourceId: ORDER_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      fromState: "PV1_APPROVED_READY_FOR_FILL",
      toState: "FILL_IN_PROGRESS",
      transitionId: "wf.v1.start_fill",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      siteId: SITE_ID,
      bucketIdAfter: FILL_BUCKET_ID,
      fillTechUserId: USER_ID,
    });
    const auditJson = JSON.stringify(auditData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(auditJson).not.toMatch(/firstName|lastName|dateOfBirth|patientId|drugName|ndc|sig/i);
  });

  it("does NOT trigger an order_event history read (no sodRules declared)", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartFill, validInput(), { idempotencyKey: "start-fill-sod" })
    );

    const oeFindCalls = callsOf(fake.calls, "orderEvent", "findFirst");
    expect(oeFindCalls).toHaveLength(1);
    const findArgs = oeFindCalls[0]!.args as { orderBy?: unknown; take?: number };
    expect(findArgs.orderBy).toBeDefined();
  });
});

describe("StartFill — input validation", () => {
  it("rejects non-UUID orderId before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, { orderId: "not-a-uuid" }, { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("rejects extra fields under strict schema", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, { ...validInput(), sneaky: "phi" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

describe("StartFill — workflow + scope failures", () => {
  it("locked row missing → ORDER_NOT_FOUND, no downstream writes", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("policy missing → WORKFLOW_POLICY_NOT_FOUND, no order update", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("policy not ACTIVE → WORKFLOW_POLICY_INACTIVE, no order update", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 1, status: "DRAFT" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("unsupported policy version → FILL_POLICY_UNSUPPORTED", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FILL_POLICY_UNSUPPORTED" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in TYPED_READY_FOR_PV1 (no PV1 yet) → FILL_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "TYPED_READY_FOR_PV1", version: 2 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FILL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in PV1_IN_PROGRESS (PV1 not approved) → FILL_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_IN_PROGRESS", version: 3 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FILL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order already FILL_IN_PROGRESS → FILL_INVALID_TRANSITION (no double-start)", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FILL_IN_PROGRESS", version: 5 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FILL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order RECEIVED (no typing yet) → FILL_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "RECEIVED", version: 0 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FILL_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order is SHIPPED (terminal) → FILL_ORDER_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "SHIPPED", version: 10 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FILL_ORDER_TERMINAL" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order is CANCELLED (terminal) → FILL_ORDER_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "CANCELLED", version: 2 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FILL_ORDER_TERMINAL" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("FILL bucket missing → FILL_BUCKET_NOT_CONFIGURED, no order update", async () => {
    const fake = buildPrismaFake({ fillBucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "FILL_BUCKET_NOT_CONFIGURED" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("factory CAS miss (concurrent writer) → ORDER_VERSION_MISMATCH, no order_event/audit/outbox", async () => {
    const fake = buildPrismaFake({ orderUpdateManyCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

describe("StartFill — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("missing FILL_START permission → PERMISSION_DENIED, no lock attempt", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    resetRbacConfigurationForTests();
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.PV1_APPROVE]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartFill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });
});
