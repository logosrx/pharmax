// EscalateOrderForSlaBreach contract tests.

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
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  EscalateOrderForSlaBreach,
  SLA_ESCALATE_BUCKET_NOT_CONFIGURED,
} from "./escalate-order-for-sla-breach.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const FILL_BUCKET_ID = "00000000-0000-4000-8000-000000000b04";
const EMERGENCY_BUCKET_ID = "00000000-0000-4000-8000-000000000eee";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORDERS_ESCALATE_SLA]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

const VALID_INPUT = {
  orderId: ORDER_ID,
  slaDeadlineAt: "2026-05-25T12:00:00.000Z",
  breachedAt: "2026-05-25T15:30:00.000Z",
};

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakeOverrides {
  lockedRow?: { currentBucketId: string; version: number } | null;
  emergencyBucket?: { id: string } | null;
  orderUpdateManyCount?: number;
}

function buildPrismaFake(overrides: FakeOverrides = {}): { client: unknown; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentBucketId: FILL_BUCKET_ID, version: 3 }
      : overrides.lockedRow;
  const emergencyBucket =
    overrides.emergencyBucket === undefined
      ? { id: EMERGENCY_BUCKET_ID }
      : overrides.emergencyBucket;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;

  const tx = {
    bucket: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findUnique", args });
        return emergencyBucket;
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
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-1" };
      }),
    },
    commandLog: { create: vi.fn(async () => ({ id: "cl-1" })) },
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
                currentBucketId: lockedRow.currentBucketId,
                currentStatus: "FILL_IN_PROGRESS",
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
    clock: clock.createFrozenClock(new Date("2026-05-25T15:30:00.000Z")),
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

describe("EscalateOrderForSlaBreach — first-time escalation", () => {
  it("moves the order into EMERGENCY, bumps version, emits sla_breach_escalated.v1", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(EscalateOrderForSlaBreach, VALID_INPUT, {
        idempotencyKey: `sla-escalate:${ORDER_ID}:1`,
      })
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      bucketId: EMERGENCY_BUCKET_ID,
      alreadyEscalated: false,
      previousBucketId: FILL_BUCKET_ID,
      version: 4,
    });

    const updates = fake.calls.filter((c) => c.table === "order" && c.op === "update");
    expect(updates).toHaveLength(1);
    expect((updates[0]!.args as { data: { currentBucketId: string } }).data.currentBucketId).toBe(
      EMERGENCY_BUCKET_ID
    );

    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany");
    const payload = (outbox!.args as { data: Array<{ eventType: string }> }).data[0]!;
    expect(payload.eventType).toBe("order.sla_breach_escalated.v1");

    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    expect((audit!.args as { data: { action: string } }).data.action).toBe(
      "order.escalated_for_sla_breach"
    );
  });
});

describe("EscalateOrderForSlaBreach — already in EMERGENCY", () => {
  it("does NOT mutate the order; audits reaffirmed + emits reaffirmed event", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentBucketId: EMERGENCY_BUCKET_ID, version: 7 },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(EscalateOrderForSlaBreach, VALID_INPUT, {
        idempotencyKey: `sla-escalate:${ORDER_ID}:2`,
      })
    );

    expect(out.alreadyEscalated).toBe(true);
    expect(out.version).toBe(7);
    const updates = fake.calls.filter((c) => c.table === "order" && c.op === "update");
    expect(updates).toHaveLength(0);
    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    expect((audit!.args as { data: { action: string } }).data.action).toBe(
      "order.sla_breach_escalation_reaffirmed"
    );
  });
});

describe("EscalateOrderForSlaBreach — guards", () => {
  it("throws SLA_ESCALATE_BUCKET_NOT_CONFIGURED when EMERGENCY bucket is missing", async () => {
    const fake = buildPrismaFake({ emergencyBucket: null });
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(EscalateOrderForSlaBreach, VALID_INPUT, {
          idempotencyKey: `sla-escalate:${ORDER_ID}:3`,
        })
      )
    ).rejects.toMatchObject({ code: SLA_ESCALATE_BUCKET_NOT_CONFIGURED });
  });

  it("denies without orders.escalate_sla", async () => {
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
    const fake = buildPrismaFake();
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(EscalateOrderForSlaBreach, VALID_INPUT, {
          idempotencyKey: `sla-escalate:${ORDER_ID}:4`,
        })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
