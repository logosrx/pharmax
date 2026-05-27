// MarkTypingMissingInfo contract tests.
//
// Headline assertions:
//   1. Happy path: TYPING_IN_PROGRESS → TYPING_PENDING_MISSING_INFO,
//      bucket resolved from BUCKET_CODE_FOR_EXCEPTION_STATE
//      (= "TYPING" — the order stays in the typing queue), assignee
//      cleared to null, audit + outbox written with the reason
//      code echoed in metadata.
//   2. Reason code validated at Zod boundary against MISSING_INFO_REASONS.
//   3. Workflow guard: invalid source state (e.g. RECEIVED, where
//      the engine has no MARK_TYPING_MISSING_INFO transition) →
//      TYPING_INVALID_TRANSITION.
//   4. Bucket-missing guard: TYPING bucket not seeded for the
//      site → TYPING_BUCKET_NOT_CONFIGURED.
//   5. RBAC: actor without TYPING_MARK_MISSING_INFO → PERMISSION_DENIED.

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

import { MarkTypingMissingInfo } from "./mark-typing-missing-info.js";

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
    permissions: new Set([PERMISSIONS.TYPING_MARK_MISSING_INFO]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: TYPIST_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

const validInput = () =>
  ({ orderId: ORDER_ID, reasonCode: "PRESCRIBER_CALLBACK_REQUIRED" }) as const;

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
      ? { currentStatus: "TYPING_IN_PROGRESS", version: 2 }
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
      input.initialOpenIntervalKind ?? OrderStageIntervalKind.TYPING_ACTIVE
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
      findFirst: vi.fn(async () => ({ sequenceNumber: 2 })),
      findMany: vi.fn(async () => []),
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

describe("MarkTypingMissingInfo — happy path", () => {
  it("transitions to TYPING_PENDING_MISSING_INFO, clears assignee, audits + outboxes with reason", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(MarkTypingMissingInfo, validInput(), { idempotencyKey: "mtmi-1" })
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      currentStatus: "TYPING_PENDING_MISSING_INFO",
      version: 3,
      reasonCode: "PRESCRIBER_CALLBACK_REQUIRED",
    });

    // bucket lookup: TYPING (from BUCKET_CODE_FOR_EXCEPTION_STATE)
    const bucketCall = fake.calls.find((c) => c.table === "bucket" && c.op === "findFirst")!;
    expect((bucketCall.args as { where: Record<string, unknown> }).where).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      code: "TYPING",
    });

    // order.update: status + bucket + assignee cleared.
    const upd = fake.calls.find((c) => c.table === "order" && c.op === "update")!;
    const data = (upd.args as { data: Record<string, unknown> }).data;
    expect(data["currentStatus"]).toBe("TYPING_PENDING_MISSING_INFO");
    expect(data["currentBucketId"]).toBe(TYPING_BUCKET_ID);
    expect(data["currentAssigneeUserId"]).toBeNull();

    // audit metadata carries the reason + pausing-typist id.
    const auditArgs = fake.calls.find((c) => c.table === "auditLog" && c.op === "create")!;
    const meta = (auditArgs.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(meta["reasonCode"]).toBe("PRESCRIBER_CALLBACK_REQUIRED");
    expect(meta["pausingTypistUserId"]).toBe(TYPIST_ID);

    // outbox: order.typing.missing_info.v1
    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany")!;
    const payload = (
      outbox.args as {
        data: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }
    ).data[0]!;
    expect(payload.eventType).toBe("order.typing.missing_info.v1");
    expect(payload.payload["reasonCode"]).toBe("PRESCRIBER_CALLBACK_REQUIRED");
  });
});

describe("MarkTypingMissingInfo — input validation", () => {
  it("rejects unknown reason at the Zod boundary", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          MarkTypingMissingInfo,
          { orderId: ORDER_ID, reasonCode: "NOT_REAL" } as unknown as ReturnType<typeof validInput>,
          { idempotencyKey: "mtmi-2" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });
});

describe("MarkTypingMissingInfo — workflow + scope failures", () => {
  it("from RECEIVED → TYPING_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "RECEIVED", version: 1 },
    });
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(MarkTypingMissingInfo, validInput(), { idempotencyKey: "mtmi-3" })
      )
    ).rejects.toMatchObject({ code: "TYPING_INVALID_TRANSITION" });
  });

  it("missing TYPING bucket → TYPING_BUCKET_NOT_CONFIGURED", async () => {
    const fake = buildPrismaFake({ typingBucketFound: false });
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(MarkTypingMissingInfo, validInput(), { idempotencyKey: "mtmi-4" })
      )
    ).rejects.toMatchObject({ code: "TYPING_BUCKET_NOT_CONFIGURED" });
  });
});

describe("MarkTypingMissingInfo — RBAC", () => {
  it("denies without TYPING_MARK_MISSING_INFO", async () => {
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
              permissions: new Set([PERMISSIONS.TYPING_START, PERMISSIONS.TYPING_COMPLETE]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake();
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(MarkTypingMissingInfo, validInput(), { idempotencyKey: "mtmi-5" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
