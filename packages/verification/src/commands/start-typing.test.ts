// StartTyping contract tests.
//
// Mirrors the `create-order.test.ts` pattern: hand-rolled Prisma fake
// per file so the suite is DB-free and the fake exposes exactly the
// tables this command touches. The fake records every call so tests
// can assert (a) what was inserted, (b) what was rejected, (c) the
// canonical step ordering enforced by the defineCommand factory.
//
// PHI invariant: no test fixture carries patient names or DOBs. We
// exercise the command with synthetic UUIDs only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { StartTyping } from "./start-typing.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const TYPING_BUCKET_ID = "00000000-0000-4000-8000-000000000010";

const orgWideTypingGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.TYPING_START]),
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

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  /**
   * Row returned by the factory's `SELECT … FOR UPDATE`. NULL means
   * "no row" — surfaces as ORDER_NOT_FOUND from the factory.
   */
  lockedRow?: {
    currentStatus: string;
    version: number;
  } | null;
  /** Row returned by `workflowPolicy.findUnique`. NULL → WORKFLOW_POLICY_NOT_FOUND. */
  policy?: { code: string; version: number; status: string } | null;
  /** Row returned by `bucket.findFirst` for typing bucket. NULL → TYPING_BUCKET_NOT_CONFIGURED. */
  typingBucketFound?: boolean;
  /** Count returned by `order.updateMany` (the factory CAS). Default 1 (hit). */
  orderUpdateManyCount?: number;
  /** Head of `order_event` for sequence numbering. Default null → next seq = 1. */
  orderEventHead?: { sequenceNumber: number } | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "RECEIVED", version: 0 }
      : overrides.lockedRow;
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const typingBucketFound = overrides.typingBucketFound ?? true;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead = overrides.orderEventHead === undefined ? null : overrides.orderEventHead;

  let openInterval: { id: string; kind: string; startedAt: Date } | null = {
    id: "interval-wait",
    kind: "WAIT_BEFORE_TYPING",
    startedAt: new Date("2026-05-23T11:00:00.000Z"),
  };

  const tx = {
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
        return typingBucketFound ? { id: TYPING_BUCKET_ID } : null;
      }),
    },
    orderStageInterval: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderStageInterval", op: "findFirst", args });
        return openInterval;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderStageInterval", op: "update", args });
        openInterval = null;
        return { id: "interval-wait" };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderStageInterval", op: "updateMany", args });
        openInterval = null;
        return { count: 1 };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderStageInterval", op: "create", args });
        const data = (args as { data: { kind: string; startedAt?: Date } }).data;
        openInterval = {
          id: "interval-active",
          kind: data.kind,
          startedAt: data.startedAt ?? new Date("2026-05-23T12:00:00.000Z"),
        };
        return { id: "interval-active" };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-2" };
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
    // The factory's $queryRaw → `SELECT … FOR UPDATE` on the order.
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
    // RLS session GUC + audit-chain advisory lock land here.
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-23T12:30:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: orgWideTypingGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("StartTyping — happy path", () => {
  it("returns the expected output and writes order.update + factory CAS + order_event + audit + outbox", async () => {
    // The order was created at seq=1 by CreateOrder; StartTyping is
    // seq=2 in that order's event chain.
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(StartTyping, validInput(), { idempotencyKey: "start-1" })
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      currentStatus: "TYPING_IN_PROGRESS",
      version: 1,
      transitionId: "wf.v1.start_typing",
    });

    // Lock fired exactly once, before anything else inside the tx
    // touches the order row.
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(1);

    // Policy load: by id (from the locked target), not by code+version.
    const policyCalls = callsOf(fake.calls, "workflowPolicy", "findUnique");
    expect(policyCalls).toHaveLength(1);
    expect((policyCalls[0]!.args as { where: unknown }).where).toEqual({ id: POLICY_ID });

    // Bucket lookup uses siteId from the locked target — no second
    // findUnique round-trip on the order row.
    expect(callsOf(fake.calls, "order", "findUnique")).toHaveLength(0);
    const bucketCall = callsOf(fake.calls, "bucket", "findFirst")[0];
    expect((bucketCall!.args as { where: Record<string, unknown> }).where).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      code: "TYPING",
    });

    // Domain write: state + bucket + assignee. NOT the version
    // (that's the factory's CAS step).
    const updateCalls = callsOf(fake.calls, "order", "update");
    expect(updateCalls).toHaveLength(1);
    const updateArgs = updateCalls[0]!.args as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateArgs.where).toEqual({ id: ORDER_ID });
    expect(updateArgs.data).toEqual({
      currentStatus: "TYPING_IN_PROGRESS",
      currentBucketId: TYPING_BUCKET_ID,
      currentAssigneeUserId: USER_ID,
    });
    expect(updateArgs.data["version"]).toBeUndefined();

    // Factory CAS: updateMany filtered on (id, organizationId, version=0).
    const casCalls = callsOf(fake.calls, "order", "updateMany");
    expect(casCalls).toHaveLength(1);
    const casArgs = casCalls[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(casArgs.where).toEqual({ id: ORDER_ID, organizationId: ORG_ID, version: 0 });
    expect(casArgs.data).toEqual({ version: 1 });

    // order_event written with seq = head+1 = 2.
    const oeCreate = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreate).toHaveLength(1);
    const oeData = (oeCreate[0]!.args as { data: Record<string, unknown> }).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.typing.started.v1",
      sequenceNumber: 2,
      actorUserId: USER_ID,
    });

    // Audit + outbox + idempotency.
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });

  it("seq=1 when the order has no prior events (defensive — should not happen post-CreateOrder)", async () => {
    const fake = buildPrismaFake({ orderEventHead: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartTyping, validInput(), { idempotencyKey: "start-2" })
    );

    const oeData = (
      callsOf(fake.calls, "orderEvent", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(oeData["sequenceNumber"]).toBe(1);
  });

  it("emits order.typing.started.v1 outbox payload with scope + transition + ISO timestamp", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartTyping, validInput(), { idempotencyKey: "start-3" })
    );

    const outboxCall = callsOf(fake.calls, "eventOutbox", "createMany")[0];
    const rows = (outboxCall!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.typing.started.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(rows[0]?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      typistUserId: USER_ID,
      bucketId: TYPING_BUCKET_ID,
      transitionId: "wf.v1.start_typing",
      fromState: "RECEIVED",
      toState: "TYPING_IN_PROGRESS",
      occurredAt: "2026-05-23T12:30:00.000Z",
    });
  });

  it("audit metadata records transition + policy + bucket WITHOUT PHI", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 1 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(StartTyping, validInput(), { idempotencyKey: "start-4" })
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(auditData).toMatchObject({
      action: "order.typing.started",
      resourceType: "Order",
      resourceId: ORDER_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      fromState: "RECEIVED",
      toState: "TYPING_IN_PROGRESS",
      transitionId: "wf.v1.start_typing",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      siteId: SITE_ID,
      bucketIdAfter: TYPING_BUCKET_ID,
      typistUserId: USER_ID,
    });
    // No PHI substrings.
    const auditJson = JSON.stringify(auditData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(auditJson).not.toMatch(/firstName|lastName|dateOfBirth|patientId/i);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("StartTyping — input validation", () => {
  it("rejects non-UUID orderId before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartTyping, { orderId: "not-a-uuid" }, { idempotencyKey: "k" })
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
        executeCommand(StartTyping, { ...validInput(), sneaky: "phi" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow + scope failures
// ---------------------------------------------------------------------------

describe("StartTyping — workflow + scope failures", () => {
  it("locked row missing → ORDER_NOT_FOUND, no downstream writes", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartTyping, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("policy missing → WORKFLOW_POLICY_NOT_FOUND (from factory), no order update", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartTyping, validInput(), { idempotencyKey: "k" })
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
        executeCommand(StartTyping, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("unsupported policy version → TYPING_POLICY_UNSUPPORTED", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartTyping, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "TYPING_POLICY_UNSUPPORTED" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in wrong state (TYPING_IN_PROGRESS) → TYPING_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "TYPING_IN_PROGRESS", version: 1 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartTyping, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "TYPING_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("order is SHIPPED (terminal) → TYPING_ORDER_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "SHIPPED", version: 7 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartTyping, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "TYPING_ORDER_TERMINAL" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("typing bucket missing → TYPING_BUCKET_NOT_CONFIGURED, no order update", async () => {
    const fake = buildPrismaFake({ typingBucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartTyping, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "TYPING_BUCKET_NOT_CONFIGURED" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("factory CAS miss (concurrent writer) → ORDER_VERSION_MISMATCH, no order_event/audit/outbox", async () => {
    const fake = buildPrismaFake({ orderUpdateManyCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartTyping, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });
    // Domain `order.update` did run (it's the handler's write before
    // the factory's CAS step). What MUST NOT run is order_event /
    // audit / outbox — because the CAS miss aborts the handler
    // before the factory writes them.
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tenancy + RBAC
// ---------------------------------------------------------------------------

describe("StartTyping — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(StartTyping, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("missing TYPING_START permission → PERMISSION_DENIED, no lock attempt", async () => {
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
              permissions: new Set([PERMISSIONS.ORDERS_READ]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(StartTyping, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });
});
