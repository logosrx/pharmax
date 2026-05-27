// EscalateOrderToEmergencyBucket contract tests.
//
// Surface:
//   - Happy path: order moves from a WORKFLOW bucket (e.g. SHIPPING)
//     into EMERGENCY, version CAS bumps, audit + outbox emitted.
//   - Already-in-EMERGENCY: command writes the audit row but does
//     NOT mutate the order; emits a `reaffirmed.v1` outbox event.
//   - EMERGENCY bucket not provisioned → ESCALATE_ORDER_BUCKET_NOT_CONFIGURED.
//   - Order not found in tenancy → ORDER_NOT_FOUND.

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

import {
  ESCALATE_ORDER_BUCKET_NOT_CONFIGURED,
  EscalateOrderToEmergencyBucket,
} from "./escalate-order-to-emergency-bucket.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const SHIPPING_BUCKET_ID = "00000000-0000-4000-8000-000000000b06";
const EMERGENCY_BUCKET_ID = "00000000-0000-4000-8000-000000000eee";
const SHIPMENT_ID = "00000000-0000-4000-8000-000000000ddd";
const TRACKING_EVENT_ID = "00000000-0000-4000-8000-000000000fff";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_ESCALATE_TO_EMERGENCY]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

function validInput() {
  return {
    orderId: ORDER_ID,
    shipmentId: SHIPMENT_ID,
    trackingEventId: TRACKING_EVENT_ID,
    externalEventId: "evt_abc123",
    reason: "EXCEPTION" as const,
    carrierStatus: "DE",
    occurredAt: "2026-05-25T15:00:00.000Z",
  };
}

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  /** Locked-row payload. Default: order sits in SHIPPING bucket. */
  lockedRow?: { currentBucketId: string; version: number } | null;
  /** Bucket lookup row. Default: EMERGENCY bucket present. */
  emergencyBucket?: { id: string; siteId: string } | null;
  /** CAS hit count returned by `order.updateMany`. Default 1. */
  orderUpdateManyCount?: number;
  /** Head row for orderEvent sequence numbering. */
  orderEventHead?: { sequenceNumber: number } | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentBucketId: SHIPPING_BUCKET_ID, version: 5 }
      : overrides.lockedRow;
  const emergencyBucket =
    overrides.emergencyBucket === undefined
      ? { id: EMERGENCY_BUCKET_ID, siteId: SITE_ID }
      : overrides.emergencyBucket;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead = overrides.orderEventHead === undefined ? null : overrides.orderEventHead;

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
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-esc" };
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
        calls.push({ table: "$queryRaw", op: "select_for_update_order", args: { sql: joined } });
        return lockedRow === null
          ? []
          : [
              {
                id: ORDER_ID,
                organizationId: ORG_ID,
                clinicId: CLINIC_ID,
                siteId: SITE_ID,
                currentBucketId: lockedRow.currentBucketId,
                currentStatus: "SHIPPED",
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

describe("EscalateOrderToEmergencyBucket — first-time escalation", () => {
  it("moves the order into EMERGENCY, CAS-bumps version, emits the v1 event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(EscalateOrderToEmergencyBucket, validInput(), {
        idempotencyKey: `escalate:${SHIPMENT_ID}:evt_abc123`,
      })
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      bucketId: EMERGENCY_BUCKET_ID,
      alreadyEscalated: false,
      previousBucketId: SHIPPING_BUCKET_ID,
      version: 6,
    });

    // Bucket updated
    const updates = fake.calls.filter((c) => c.table === "order" && c.op === "update");
    expect(updates).toHaveLength(1);
    expect((updates[0]!.args as { data: { currentBucketId: string } }).data.currentBucketId).toBe(
      EMERGENCY_BUCKET_ID
    );

    // CAS issued (order.updateMany for version bump)
    const cas = fake.calls.filter((c) => c.table === "order" && c.op === "updateMany");
    expect(cas).toHaveLength(1);

    // Outbox got the v1 escalation event
    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    expect(outboxCalls).toHaveLength(1);
    const outboxData = (
      outboxCalls[0]!.args as {
        data: Array<{ eventType: string; payload: Record<string, unknown> }>;
      }
    ).data;
    expect(outboxData[0]?.eventType).toBe("order.escalated_to_emergency.v1");
    expect(outboxData[0]?.payload["reason"]).toBe("EXCEPTION");
    expect(outboxData[0]?.payload["newBucketId"]).toBe(EMERGENCY_BUCKET_ID);
    expect(outboxData[0]?.payload["previousBucketId"]).toBe(SHIPPING_BUCKET_ID);
  });
});

describe("EscalateOrderToEmergencyBucket — already in EMERGENCY", () => {
  it("emits a reaffirmed event, does NOT mutate the order, does NOT CAS", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentBucketId: EMERGENCY_BUCKET_ID, version: 12 },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(EscalateOrderToEmergencyBucket, validInput(), {
        idempotencyKey: `escalate:${SHIPMENT_ID}:evt_abc124`,
      })
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      bucketId: EMERGENCY_BUCKET_ID,
      alreadyEscalated: true,
      previousBucketId: null,
      version: 12,
    });

    // No order mutation, no CAS
    expect(fake.calls.filter((c) => c.table === "order" && c.op === "update")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.table === "order" && c.op === "updateMany")).toHaveLength(0);

    // But the outbox still records the reaffirmation
    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    expect(outboxCalls).toHaveLength(1);
    const outboxData = (outboxCalls[0]!.args as { data: Array<{ eventType: string }> }).data;
    expect(outboxData[0]?.eventType).toBe("order.shipment_escalation_reaffirmed.v1");
  });
});

describe("EscalateOrderToEmergencyBucket — guards", () => {
  it("throws ESCALATE_ORDER_BUCKET_NOT_CONFIGURED when no EMERGENCY bucket is provisioned", async () => {
    const fake = buildPrismaFake({ emergencyBucket: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(EscalateOrderToEmergencyBucket, validInput(), {
          idempotencyKey: `escalate:${SHIPMENT_ID}:evt_abc125`,
        })
      )
    ).rejects.toMatchObject({ code: ESCALATE_ORDER_BUCKET_NOT_CONFIGURED });
  });

  it("rejects when the order is not in this tenancy (no lock row)", async () => {
    const fake = buildPrismaFake({ lockedRow: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(EscalateOrderToEmergencyBucket, validInput(), {
          idempotencyKey: `escalate:${SHIPMENT_ID}:evt_abc126`,
        })
      )
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });
});
