// ResumeTyping contract tests.
//
// Symmetric with MarkTypingMissingInfo. Headline assertions:
//   1. Happy path: TYPING_PENDING_MISSING_INFO → TYPING_IN_PROGRESS,
//      bucket resolved from BUCKET_CODE_FOR_STATUS (= "TYPING"),
//      assignee SET to the resuming typist (NOT cleared), audit
//      + outbox written.
//   2. Workflow guard: invalid source state (e.g. PV1_IN_PROGRESS,
//      where the engine has no RESUME_TYPING_AFTER_INFO_RECEIVED
//      transition) → TYPING_INVALID_TRANSITION.
//   3. RBAC: reuses TYPING_START (same gate as the inbox claim
//      action — structurally the same "typist begins active work"
//      command). Denied without TYPING_START → PERMISSION_DENIED.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { OrderStageIntervalKind, RoleScope } from "@pharmax/database";
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

import { ResumeTyping } from "./resume-typing.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const TYPIST_ID = "00000000-0000-4000-8000-000000000099";
const TYPING_BUCKET_ID = "00000000-0000-4000-8000-0000000000bb";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.TYPING_START]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: TYPIST_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

const validInput = () => ({ orderId: ORDER_ID }) as const;

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

function buildPrismaFake(
  input: {
    lockedRow?: { currentStatus: string; version: number } | null;
    typingBucketFound?: boolean;
    orderUpdateManyCount?: number;
    initialOpenIntervalKind?: OrderStageIntervalKind;
  } = {}
) {
  const calls: FakeCall[] = [];
  const lockedRow =
    input.lockedRow === undefined
      ? { currentStatus: "TYPING_PENDING_MISSING_INFO", version: 3 }
      : input.lockedRow;
  const typingBucketFound = input.typingBucketFound ?? true;
  const orderUpdateManyCount = input.orderUpdateManyCount ?? 1;

  const tx = {
    workflowPolicy: {
      findUnique: vi.fn(async () => ({
        id: POLICY_ID,
        code: "order.standard",
        version: 1,
        status: "ACTIVE",
      })),
    },
    orderStageInterval: createOrderStageIntervalTxStub(
      (table, op, args) => calls.push({ table, op, args }),
      // Order is in TYPING_PENDING_MISSING_INFO → the open
      // interval kind is WAIT_BEFORE_TYPING (per the
      // stage-interval-state-map).
      input.initialOpenIntervalKind ?? OrderStageIntervalKind.WAIT_BEFORE_TYPING
    ),
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
    orderEvent: {
      findFirst: vi.fn(async () => ({ sequenceNumber: 3 })),
      findMany: vi.fn(async () => []),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-4" };
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
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    idempotencyKey: { create: vi.fn(async () => ({ ok: true })) },
    $queryRaw: vi.fn(async (template: TemplateStringsArray) => {
      const joined = template.join("?");
      if (/\bFROM\s+"?order"?\b/i.test(joined) && /\bFOR\s+UPDATE\b/i.test(joined)) {
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
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { client, calls };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-26T20:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: TYPIST_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("ResumeTyping — happy path", () => {
  it("transitions back to TYPING_IN_PROGRESS, sets assignee to the resuming typist", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(ResumeTyping, validInput(), { idempotencyKey: "rt-1" })
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      currentStatus: "TYPING_IN_PROGRESS",
      version: 4,
    });

    const upd = fake.calls.find((c) => c.table === "order" && c.op === "update")!;
    const data = (upd.args as { data: Record<string, unknown> }).data;
    expect(data["currentStatus"]).toBe("TYPING_IN_PROGRESS");
    expect(data["currentBucketId"]).toBe(TYPING_BUCKET_ID);
    expect(data["currentAssigneeUserId"]).toBe(TYPIST_ID);

    const auditArgs = fake.calls.find((c) => c.table === "auditLog" && c.op === "create")!;
    const meta = (auditArgs.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(meta["resumingTypistUserId"]).toBe(TYPIST_ID);

    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany")!;
    const payload = (outbox.args as { data: ReadonlyArray<{ eventType: string }> }).data[0]!;
    expect(payload.eventType).toBe("order.typing.resumed.v1");
  });
});

describe("ResumeTyping — workflow + scope failures", () => {
  it("from PV1_IN_PROGRESS → TYPING_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_IN_PROGRESS", version: 4 },
    });
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(ResumeTyping, validInput(), { idempotencyKey: "rt-2" })
      )
    ).rejects.toMatchObject({ code: "TYPING_INVALID_TRANSITION" });
  });
});

describe("ResumeTyping — RBAC", () => {
  it("denies without TYPING_START", async () => {
    resetRbacConfigurationForTests();
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: TYPIST_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.TYPING_COMPLETE]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake();
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(ResumeTyping, validInput(), { idempotencyKey: "rt-3" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
