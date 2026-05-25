// ConfirmShipment contract tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope, ShipmentStatus, OrderStageIntervalKind } from "@pharmax/database";
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

import { ConfirmShipment, SHIPMENT_NOT_FOUND, SHIPMENT_NOT_READY } from "./confirm-shipment.js";
import { SHIP_NOT_ASSIGNED_TO_ACTOR } from "../shipping-guards.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const SHIPPING_BUCKET_ID = "00000000-0000-4000-8000-0000000000dd";
const SHIPMENT_ID = "00000000-0000-4000-8000-0000000000ee";

const shipConfirmGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_CONFIRM]),
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
  assigneeUserId?: string | null;
  policy?: { code: string; version: number; status: string } | null;
  shipment?: { id: string; status: string; trackingNumber: string } | null;
  shippingBucketFound?: boolean;
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
      ? { currentStatus: "READY_TO_SHIP", version: 10 }
      : overrides.lockedRow;
  const assigneeUserId =
    overrides.assigneeUserId === undefined ? USER_ID : overrides.assigneeUserId;
  const policy =
    overrides.policy === undefined
      ? { code: "order.standard", version: 1, status: "ACTIVE" }
      : overrides.policy;
  const shipment =
    overrides.shipment === undefined
      ? {
          id: SHIPMENT_ID,
          status: ShipmentStatus.CREATED,
          trackingNumber: "9400111899223344556677",
        }
      : overrides.shipment;
  const shippingBucketFound = overrides.shippingBucketFound ?? true;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;
  const orderEventHead =
    "orderEventHead" in overrides ? (overrides.orderEventHead ?? null) : { sequenceNumber: 10 };

  const tx = {
    orderStageInterval: createOrderStageIntervalTxStub(
      (table, op, args) => calls.push({ table, op, args }),
      OrderStageIntervalKind.SHIPPING_ACTIVE
    ),
    workflowPolicy: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "findUnique", args });
        return policy === null ? null : { id: POLICY_ID, ...policy };
      }),
    },
    order: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "findFirst", args });
        return { currentAssigneeUserId: assigneeUserId };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "update", args });
        return { id: ORDER_ID };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: orderUpdateManyCount };
      }),
    },
    shipment: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "shipment", op: "findFirst", args });
        return shipment;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "shipment", op: "update", args });
        return { id: SHIPMENT_ID };
      }),
    },
    bucket: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findFirst", args });
        return shippingBucketFound ? { id: SHIPPING_BUCKET_ID } : null;
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHead;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-11" };
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
    clock: clock.createFrozenClock(new Date("2026-05-23T17:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: shipConfirmGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("ConfirmShipment — happy path", () => {
  it("transitions order to SHIPPED, confirms shipment, clears assignee", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(ConfirmShipment, validInput(), { idempotencyKey: "confirm-ship-1" })
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      currentStatus: "SHIPPED",
      shipmentId: SHIPMENT_ID,
      version: 11,
      transitionId: "wf.v1.confirm_shipment",
    });

    const orderUpdate = (
      callsOf(fake.calls, "order", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(orderUpdate).toMatchObject({
      currentStatus: "SHIPPED",
      currentBucketId: SHIPPING_BUCKET_ID,
      currentAssigneeUserId: null,
      shippedAt: new Date("2026-05-23T17:00:00.000Z"),
    });

    const shipmentUpdate = (
      callsOf(fake.calls, "shipment", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(shipmentUpdate).toMatchObject({
      status: ShipmentStatus.CONFIRMED,
      confirmedByUserId: USER_ID,
      confirmedAt: new Date("2026-05-23T17:00:00.000Z"),
    });

    const rows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(rows[0]?.["eventType"]).toBe("order.shipped.v1");
    expect(rows[0]?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      shipmentId: SHIPMENT_ID,
      transitionId: "wf.v1.confirm_shipment",
      occurredAt: "2026-05-23T17:00:00.000Z",
    });
  });
});

describe("ConfirmShipment — guards", () => {
  it("no shipment row → SHIPMENT_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ shipment: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ConfirmShipment, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: SHIPMENT_NOT_FOUND });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("shipment already CONFIRMED → SHIPMENT_NOT_READY", async () => {
    const fake = buildPrismaFake({
      shipment: {
        id: SHIPMENT_ID,
        status: ShipmentStatus.CONFIRMED,
        trackingNumber: "9400111899223344556677",
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ConfirmShipment, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: SHIPMENT_NOT_READY });
    });
  });

  it("wrong order status → SHIP_INVALID_TRANSITION", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP", version: 9 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ConfirmShipment, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "SHIP_INVALID_TRANSITION" });
    });
  });

  it("assignee mismatch → SHIP_NOT_ASSIGNED_TO_ACTOR", async () => {
    const fake = buildPrismaFake({ assigneeUserId: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ConfirmShipment, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: SHIP_NOT_ASSIGNED_TO_ACTOR });
    });
  });

  it("already SHIPPED (terminal) → SHIP_ORDER_TERMINAL", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "SHIPPED", version: 12 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ConfirmShipment, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "SHIP_ORDER_TERMINAL" });
    });
  });

  it("SHIPPING bucket missing → SHIPPING_BUCKET_NOT_CONFIGURED", async () => {
    const fake = buildPrismaFake({ shippingBucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ConfirmShipment, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "SHIPPING_BUCKET_NOT_CONFIGURED" });
    });
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("unsupported policy → SHIP_POLICY_UNSUPPORTED", async () => {
    const fake = buildPrismaFake({
      policy: { code: "order.standard", version: 2, status: "ACTIVE" },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ConfirmShipment, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "SHIP_POLICY_UNSUPPORTED" });
    });
  });

  it("factory CAS miss → ORDER_VERSION_MISMATCH", async () => {
    const fake = buildPrismaFake({ orderUpdateManyCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ConfirmShipment, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });
  });
});

describe("ConfirmShipment — RBAC + tenancy", () => {
  it("missing SHIP_CONFIRM → PERMISSION_DENIED", async () => {
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
              permissions: new Set([PERMISSIONS.SHIP_CREATE]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(ConfirmShipment, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
  });

  it("no tenancy context → TENANCY_NO_CONTEXT", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(ConfirmShipment, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
  });
});
