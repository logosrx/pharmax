// CompleteTypingReview contract tests.
//
// Mirrors `start-typing.test.ts` — hand-rolled Prisma fake per file,
// no shared helpers yet. The diff from StartTyping's suite is exactly
// the diff between the two commands:
//
//   - Source state is TYPING_IN_PROGRESS (not RECEIVED), so the
//     "wrong state" case here is the order being still in RECEIVED
//     or already in TYPED_READY_FOR_PV1 (skipping ahead).
//   - Destination bucket code is "PV1" (not "TYPING").
//   - Assignee CLEARS to null rather than being set to the actor —
//     this is the assignee-clear convention every future Complete*
//     and Approve* command will follow.
//   - Stable error codes are SHARED with StartTyping (re-exported
//     from `start-typing.js`): `TYPING_POLICY_UNSUPPORTED`,
//     `TYPING_INVALID_TRANSITION`, `TYPING_ORDER_TERMINAL`. Only
//     `PV1_BUCKET_NOT_CONFIGURED` is unique to this command.
//
// PHI invariant: no fixture carries names, DOBs, or any patient
// identifier beyond an opaque orderId UUID.

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

import { CompleteTypingReview } from "./complete-typing-review.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const PV1_BUCKET_ID = "00000000-0000-4000-8000-000000000011";

const orgWideTypingCompleteGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.TYPING_COMPLETE]),
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
  // Default: TYPING_IN_PROGRESS / version=1 (CreateOrder=0 → StartTyping bumped to 1).
  lockedRow?: {
    currentStatus: string;
    version: number;
  } | null;
  policy?: { code: string; version: number; status: string } | null;
  pv1BucketFound?: boolean;
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
      ? { currentStatus: "TYPING_IN_PROGRESS", version: 1 }
      : overrides.lockedRow;
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const pv1BucketFound = overrides.pv1BucketFound ?? true;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead = overrides.orderEventHead === undefined ? null : overrides.orderEventHead;

  const tx = {
    orderStageInterval: createOrderStageIntervalTxStub(
      (table, op, args) => calls.push({ table, op, args }),
      OrderStageIntervalKind.TYPING_ACTIVE
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
        return pv1BucketFound ? { id: PV1_BUCKET_ID } : null;
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-3" };
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
    // Factory's SELECT … FOR UPDATE for the locked order row. The
    // projection MUST include clinicId + siteId so the handler can
    // read them off `target` (LockedOrderTarget) without a second
    // findUnique. Missing either field is exactly the bug that
    // shipped briefly in this test file — the bucket lookup ran with
    // `siteId: undefined`.
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-23T13:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: orgWideTypingCompleteGrants },
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

describe("CompleteTypingReview — happy path", () => {
  it("returns output, writes state update + CAS + order_event seq=3 + audit + outbox", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 2 } });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "complete-1" })
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      currentStatus: "TYPED_READY_FOR_PV1",
      version: 2,
      transitionId: "wf.v1.complete_typing_review",
    });

    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(1);

    const policyCalls = callsOf(fake.calls, "workflowPolicy", "findUnique");
    expect(policyCalls).toHaveLength(1);
    expect((policyCalls[0]!.args as { where: unknown }).where).toEqual({ id: POLICY_ID });

    // PV1 bucket lookup — NOT TYPING (that was StartTyping's target).
    const bucketCall = callsOf(fake.calls, "bucket", "findFirst")[0];
    expect((bucketCall!.args as { where: Record<string, unknown> }).where).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      code: "PV1",
    });

    const updateArgs = callsOf(fake.calls, "order", "update")[0]!.args as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateArgs.where).toEqual({ id: ORDER_ID });
    expect(updateArgs.data).toEqual({
      currentStatus: "TYPED_READY_FOR_PV1",
      currentBucketId: PV1_BUCKET_ID,
      currentAssigneeUserId: null,
    });
    // The version column is the factory's responsibility — not the
    // handler's. If this ever shows up in `data`, two writers will
    // race on the version and the CAS will silently double-bump.
    expect(updateArgs.data["version"]).toBeUndefined();

    // CAS on (id, organizationId, version: 1) → version: 2.
    const casArgs = callsOf(fake.calls, "order", "updateMany")[0]!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(casArgs.where).toEqual({ id: ORDER_ID, organizationId: ORG_ID, version: 1 });
    expect(casArgs.data).toEqual({ version: 2 });

    // seq = head (2) + 1 = 3.
    const oeData = (
      callsOf(fake.calls, "orderEvent", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.typing.completed.v1",
      sequenceNumber: 3,
      actorUserId: USER_ID,
    });

    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });

  it("clears currentAssigneeUserId to null (assignee-clear convention)", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 2 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "complete-2" })
    );

    const updateData = (
      callsOf(fake.calls, "order", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(updateData["currentAssigneeUserId"]).toBeNull();
  });

  it("emits order.typing.completed.v1 outbox with completedByUserId", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 2 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "complete-3" })
    );

    const rows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(rows[0]).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.typing.completed.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(rows[0]?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      completedByUserId: USER_ID,
      bucketId: PV1_BUCKET_ID,
      transitionId: "wf.v1.complete_typing_review",
      fromState: "TYPING_IN_PROGRESS",
      toState: "TYPED_READY_FOR_PV1",
      occurredAt: "2026-05-23T13:00:00.000Z",
    });
  });

  it("defensive: order_event head=null → sequenceNumber=1", async () => {
    // Should never happen in practice — `CreateOrder` already wrote
    // seq=1 and `StartTyping` wrote seq=2 by the time
    // CompleteTypingReview runs. But the factory's monotonic helper
    // tolerates a null head; this test pins that the handler doesn't
    // do anything that would break the helper's null-head fallback.
    const fake = buildPrismaFake({ orderEventHead: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "complete-defensive" })
    );

    const oeData = (
      callsOf(fake.calls, "orderEvent", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(oeData["sequenceNumber"]).toBe(1);
  });

  it("audit metadata records transition + policy + completer userId WITHOUT PHI", async () => {
    const fake = buildPrismaFake({ orderEventHead: { sequenceNumber: 2 } });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "complete-4" })
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(auditData).toMatchObject({
      action: "order.typing.completed",
      resourceType: "Order",
      resourceId: ORDER_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      fromState: "TYPING_IN_PROGRESS",
      toState: "TYPED_READY_FOR_PV1",
      transitionId: "wf.v1.complete_typing_review",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      siteId: SITE_ID,
      bucketIdAfter: PV1_BUCKET_ID,
      completedByUserId: USER_ID,
    });
    const auditJson = JSON.stringify(auditData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(auditJson).not.toMatch(/firstName|lastName|dateOfBirth|patientId/i);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("CompleteTypingReview — input validation", () => {
  it("rejects non-UUID orderId before any DB write", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, { orderId: "not-a-uuid" }, { idempotencyKey: "k" })
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
        executeCommand(CompleteTypingReview, { ...validInput(), sneaky: "phi" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow + scope failures
// ---------------------------------------------------------------------------

describe("CompleteTypingReview — workflow + scope failures", () => {
  it("locked row missing → ORDER_NOT_FOUND, no downstream writes", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
  });

  it("policy missing → WORKFLOW_POLICY_NOT_FOUND, no order update", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("policy ARCHIVED → WORKFLOW_POLICY_INACTIVE, no order update", async () => {
    // Per ADR-0017 the in-flight selector (`loadPolicy: { from:
    // "target" }`) ACCEPTS ACTIVE and SUPERSEDED (grandfather
    // rule) and REJECTS DRAFT and ARCHIVED. ARCHIVED is the
    // operator asserting that no in-flight order should still
    // reference this row; if a command lands referencing an
    // ARCHIVED row, the archival was premature and the command
    // must fail loudly rather than silently advancing state on
    // an unsupported policy. The grandfather-readable case
    // (SUPERSEDED → command succeeds) is covered by the
    // dedicated test in `@pharmax/command-bus` define-command.test.ts.
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 1, status: "ARCHIVED" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("unsupported policy version → TYPING_POLICY_UNSUPPORTED (shared with StartTyping)", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "TYPING_POLICY_UNSUPPORTED" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order in RECEIVED (no typing started) → TYPING_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "RECEIVED", version: 0 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "TYPING_INVALID_TRANSITION" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("order in TYPED_READY_FOR_PV1 (already past this step) → TYPING_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "TYPED_READY_FOR_PV1", version: 2 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "TYPING_INVALID_TRANSITION" });
    });
  });

  it("order is CANCELLED (terminal) → TYPING_ORDER_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "CANCELLED", version: 5 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "TYPING_ORDER_TERMINAL" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("order is SHIPPED (terminal) → TYPING_ORDER_TERMINAL", async () => {
    // The two terminal states behave identically through the engine
    // guard — pinning both ensures a future engine refactor that
    // splits "completed" terminals from "exception" terminals doesn't
    // silently change which one we reject here.
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "SHIPPED", version: 10 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "TYPING_ORDER_TERMINAL" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("PV1 bucket missing → PV1_BUCKET_NOT_CONFIGURED, no order update", async () => {
    const fake = buildPrismaFake({ pv1BucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PV1_BUCKET_NOT_CONFIGURED" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("factory CAS miss → ORDER_VERSION_MISMATCH (order.update ran; order_event/audit/outbox did NOT)", async () => {
    const fake = buildPrismaFake({ orderUpdateManyCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(1);
    expect(callsOf(fake.calls, "orderEvent", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tenancy + RBAC
// ---------------------------------------------------------------------------

describe("CompleteTypingReview — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });

  it("missing TYPING_COMPLETE permission → PERMISSION_DENIED, no lock attempt", async () => {
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
              // Has TYPING_START but NOT TYPING_COMPLETE — the realistic
              // "wrong stage of the workflow" mistake.
              permissions: new Set([PERMISSIONS.TYPING_START, PERMISSIONS.ORDERS_READ]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CompleteTypingReview, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });
});
