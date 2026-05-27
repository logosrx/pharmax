import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { OrderStageIntervalKind, ReopenReason, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { createOrderStageIntervalTxStub } from "@pharmax/sla/test-utils";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import {
  ORDER_REOPEN_BUCKET_NOT_CONFIGURED,
  ORDER_REOPEN_INVALID_FROM,
  ORDER_REOPEN_INVALID_TARGET,
  ORDER_REOPEN_TERMINAL_STATE,
  ReopenForCorrection,
} from "./reopen-for-correction.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-0000000000c2";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const REOPEN_ID = "00000000-0000-4000-8000-00000000001r";
const BUCKET_ID = "00000000-0000-4000-8000-0000000000b1";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORDERS_REOPEN_FOR_CORRECTION]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

function validInput(overrides: Partial<{ reopenToState: string }> = {}) {
  return {
    orderId: ORDER_ID,
    reopenToState: "FILL_IN_PROGRESS" as const,
    reason: ReopenReason.FILL_REDO,
    ...overrides,
  };
}

interface FakeOverrides {
  lockedRow?: {
    currentStatus: string;
    version: number;
  } | null;
  bucket?: { id: string } | null;
  orderUpdateManyCount?: number;
  /**
   * Kind of the currently-open `OrderStageInterval` row. ReopenForCorrection
   * is handler-direct: it closes the interval that corresponds to the
   * locked row's currentStatus and opens the interval for `reopenToState`.
   * Tests must pass a value consistent with `lockedRow.currentStatus`.
   * Defaults to `WAIT_AFTER_FINAL_REJECT` to match the default
   * `FINAL_VERIFICATION_REJECTED` locked row.
   */
  initialOpenIntervalKind?: OrderStageIntervalKind;
}

function buildPrismaFake(overrides: FakeOverrides = {}) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];
  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "FINAL_VERIFICATION_REJECTED", version: 7 }
      : overrides.lockedRow;
  const bucket = overrides.bucket === undefined ? { id: BUCKET_ID } : overrides.bucket;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;

  const tx = {
    workflowPolicy: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "findUnique", args });
        return { id: POLICY_ID, code: "order.standard", version: 1, status: "ACTIVE" };
      }),
    },
    orderStageInterval: createOrderStageIntervalTxStub(
      (table, op, args) => calls.push({ table, op, args }),
      overrides.initialOpenIntervalKind ?? OrderStageIntervalKind.WAIT_AFTER_FINAL_REJECT
    ),
    bucket: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findFirst", args });
        return bucket;
      }),
    },
    orderCorrectionReopen: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderCorrectionReopen", op: "create", args });
        return { id: REOPEN_ID };
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
    orderEvent: {
      findFirst: vi.fn(async () => ({ sequenceNumber: 7 })),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-8" };
      }),
    },
    commandLog: { create: vi.fn(async () => ({ id: "cl-1" })) },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
    idempotencyKey: { create: vi.fn(async () => ({ ok: true })) },
    $queryRaw: vi.fn(async () =>
      lockedRow === null
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
          ]
    ),
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls, tx };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as never,
    clock: clock.createFrozenClock(new Date("2026-05-29T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("ReopenForCorrection — happy path", () => {
  it("reopens FINAL_VERIFICATION_REJECTED → FILL_IN_PROGRESS with assignee", async () => {
    const { client, calls } = buildPrismaFake();
    configureBus(client);

    const result = await withTenancyContext(ctxFor(), () =>
      executeCommand(ReopenForCorrection, validInput(), { idempotencyKey: "reopen-1" })
    );

    expect(result).toMatchObject({
      orderId: ORDER_ID,
      correctionReopenId: REOPEN_ID,
      currentStatus: "FILL_IN_PROGRESS",
      reopenedFromStatus: "FINAL_VERIFICATION_REJECTED",
      version: 8,
      transitionId: "wf.v1.reopen_from_final_rejected",
    });
    expect(calls.some((c) => c.table === "orderCorrectionReopen" && c.op === "create")).toBe(true);
    const orderUpdate = calls.find((c) => c.table === "order" && c.op === "update");
    expect(orderUpdate?.args).toMatchObject({
      data: {
        currentStatus: "FILL_IN_PROGRESS",
        currentBucketId: BUCKET_ID,
        currentAssigneeUserId: USER_ID,
      },
    });

    // SLA: close WAIT_AFTER_FINAL_REJECT (the open kind for the
    // source state FINAL_VERIFICATION_REJECTED, asserted by the
    // primitive's `expectedKind`) and open FILL_ACTIVE — an ACTIVE
    // kind, so the reopener becomes the actor and matches the
    // order row's `currentAssigneeUserId` flip above.
    const slaCloseCalls = calls.filter(
      (c) => c.table === "orderStageInterval" && c.op === "updateMany"
    );
    expect(slaCloseCalls).toHaveLength(1);

    const slaOpenCalls = calls.filter((c) => c.table === "orderStageInterval" && c.op === "create");
    expect(slaOpenCalls).toHaveLength(1);
    const slaOpenData = (slaOpenCalls[0]!.args as { data: Record<string, unknown> }).data;
    expect(slaOpenData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      siteId: SITE_ID,
      kind: OrderStageIntervalKind.FILL_ACTIVE,
      actorUserId: USER_ID,
    });
  });

  it("reopens PV1_REJECTED → TYPED_READY_FOR_PV1 without assignee", async () => {
    const { client, tx } = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_REJECTED", version: 4 },
      initialOpenIntervalKind: OrderStageIntervalKind.WAIT_AFTER_PV1_REJECT,
    });
    configureBus(client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(ReopenForCorrection, validInput({ reopenToState: "TYPED_READY_FOR_PV1" }), {
        idempotencyKey: "reopen-2",
      })
    );

    expect(tx.bucket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ code: "PV1" }),
      })
    );
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentStatus: "TYPED_READY_FOR_PV1",
          currentAssigneeUserId: null,
        }),
      })
    );
  });
});

describe("ReopenForCorrection — guards", () => {
  it("rejects reopen from non-rejection state", async () => {
    const { client } = buildPrismaFake({
      lockedRow: { currentStatus: "FILL_IN_PROGRESS", version: 3 },
    });
    configureBus(client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(ReopenForCorrection, validInput(), { idempotencyKey: "k" })
      )
    ).rejects.toMatchObject({ code: ORDER_REOPEN_INVALID_FROM });
  });

  it("rejects reopen from terminal state", async () => {
    const { client } = buildPrismaFake({
      lockedRow: { currentStatus: "SHIPPED", version: 10 },
    });
    configureBus(client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(ReopenForCorrection, validInput(), { idempotencyKey: "k" })
      )
    ).rejects.toMatchObject({ code: ORDER_REOPEN_TERMINAL_STATE });
  });

  it("rejects invalid reopen target for source state", async () => {
    const { client } = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_REJECTED", version: 2 },
    });
    configureBus(client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(ReopenForCorrection, validInput({ reopenToState: "FILL_IN_PROGRESS" }), {
          idempotencyKey: "k",
        })
      )
    ).rejects.toMatchObject({ code: ORDER_REOPEN_INVALID_TARGET });
  });

  it("surfaces missing bucket as ORDER_REOPEN_BUCKET_NOT_CONFIGURED", async () => {
    const { client } = buildPrismaFake({ bucket: null });
    configureBus(client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(ReopenForCorrection, validInput(), { idempotencyKey: "k" })
      )
    ).rejects.toMatchObject({ code: ORDER_REOPEN_BUCKET_NOT_CONFIGURED });
  });
});

describe("ReopenForCorrection — input validation", () => {
  it("requires reasonText when reason is OTHER", async () => {
    const { client } = buildPrismaFake();
    configureBus(client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ReopenForCorrection,
          {
            orderId: ORDER_ID,
            reopenToState: "FILL_IN_PROGRESS",
            reason: ReopenReason.OTHER,
          },
          { idempotencyKey: "k" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });
});

describe("ReopenForCorrection — RBAC", () => {
  it("denies without orders.reopen_for_correction", async () => {
    configureRbac({ loader: new InMemoryPermissionLoader([]) });
    const { client } = buildPrismaFake();
    configureBus(client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(ReopenForCorrection, validInput(), { idempotencyKey: "k" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
