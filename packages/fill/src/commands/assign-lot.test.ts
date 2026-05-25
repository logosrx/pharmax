// AssignLot contract tests — lot validation, inventory write, version CAS.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { LotStatus, Prisma, RoleScope } from "@pharmax/database";
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
  AssignLot,
  LOT_EXPIRED,
  LOT_HELD,
  LOT_NOT_FOUND,
  LOT_PRODUCT_MISMATCH,
  LOT_SITE_MISMATCH,
  ORDER_LINE_NOT_FOUND,
} from "./assign-lot.js";
import { FILL_NOT_ASSIGNED_TO_ACTOR, FILL_WRONG_STATUS } from "../fill-guards.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORDER_LINE_ID = "00000000-0000-4000-8000-0000000000bb";
const LOT_ID = "00000000-0000-4000-8000-0000000000cc";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const NDC = "12345678901";

const fillGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.FILL_ASSIGN_LOT]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

const validInput = () => ({
  orderId: ORDER_ID,
  orderLineId: ORDER_LINE_ID,
  lotId: LOT_ID,
});

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  lockedRow?: { currentStatus: string; version: number } | null;
  assigneeUserId?: string | null;
  orderLine?: Record<string, unknown> | null;
  lot?: Record<string, unknown> | null;
  orderUpdateManyCount?: number;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "FILL_IN_PROGRESS", version: 5 }
      : overrides.lockedRow;
  const assigneeUserId =
    overrides.assigneeUserId === undefined ? USER_ID : overrides.assigneeUserId;
  const orderLine =
    overrides.orderLine === undefined
      ? {
          id: ORDER_LINE_ID,
          quantityToFill: new Prisma.Decimal(10),
          prescription: { drugNdc: NDC },
        }
      : overrides.orderLine;
  const lot =
    overrides.lot === undefined
      ? {
          id: LOT_ID,
          siteId: SITE_ID,
          lotNumber: "LOT-A1",
          expirationDate: new Date("2027-12-31T00:00:00.000Z"),
          status: LotStatus.ACTIVE,
          product: { ndc: NDC },
        }
      : overrides.lot;
  const orderUpdateManyCount = overrides.orderUpdateManyCount ?? 1;

  const tx = {
    order: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "findFirst", args });
        return { currentAssigneeUserId: assigneeUserId };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: orderUpdateManyCount };
      }),
    },
    orderLine: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "findFirst", args });
        return orderLine;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "update", args });
        return { id: ORDER_LINE_ID };
      }),
    },
    lot: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "lot", op: "findFirst", args });
        return lot;
      }),
    },
    lotAssignment: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "lotAssignment", op: "create", args });
        return { id: "la-1" };
      }),
    },
    inventoryTransaction: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "inventoryTransaction", op: "create", args });
        return { id: "it-1" };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return { sequenceNumber: 5 };
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
      const op =
        /\bFROM\s+"?order"?\b/i.test(joined) && /\bFOR\s+UPDATE\b/i.test(joined)
          ? "select_for_update_order"
          : "raw";
      calls.push({ table: "$queryRaw", op, args: { sql: joined, values: [...values] } });
      if (op === "select_for_update_order") {
        return lockedRow === null
          ? []
          : [
              {
                id: ORDER_ID,
                organizationId: ORG_ID,
                siteId: SITE_ID,
                currentStatus: lockedRow.currentStatus,
                version: lockedRow.version,
              },
            ];
      }
      return [];
    }),
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        calls.push({
          table: "$executeRaw",
          op: "set_config",
          args: { sql: template.join("?"), values: [...values] },
        });
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
      { organizationId: ORG_ID, userId: USER_ID, grants: fillGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("AssignLot — happy path", () => {
  it("creates lot assignment, inventory transaction, and bumps order version", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(AssignLot, validInput(), { idempotencyKey: "assign-lot-1" })
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      orderLineId: ORDER_LINE_ID,
      lotId: LOT_ID,
      lotAssignmentId: "la-1",
      version: 6,
    });

    const invData = (
      callsOf(fake.calls, "inventoryTransaction", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(invData).toMatchObject({
      lotId: LOT_ID,
      orderLineId: ORDER_LINE_ID,
      reason: "LOT_ASSIGNED",
    });
    expect((invData["quantityDelta"] as Prisma.Decimal).toString()).toBe("-10");

    const lineUpdate = (
      callsOf(fake.calls, "orderLine", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(lineUpdate).toMatchObject({ lotId: LOT_ID });

    const outboxRows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(outboxRows[0]).toMatchObject({
      eventType: "fill.lot.assigned.v1",
      aggregateType: "OrderLine",
      aggregateId: ORDER_LINE_ID,
    });
  });
});

describe("AssignLot — guards", () => {
  it("wrong order status → FILL_WRONG_STATUS", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_APPROVED_READY_FOR_FILL", version: 4 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AssignLot, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: FILL_WRONG_STATUS });
    });
    expect(callsOf(fake.calls, "lotAssignment", "create")).toHaveLength(0);
  });

  it("not assignee → FILL_NOT_ASSIGNED_TO_ACTOR", async () => {
    const fake = buildPrismaFake({ assigneeUserId: "other-user" });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AssignLot, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: FILL_NOT_ASSIGNED_TO_ACTOR });
    });
    expect(callsOf(fake.calls, "lot", "findFirst")).toHaveLength(0);
  });

  it("order line missing → ORDER_LINE_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ orderLine: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AssignLot, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: ORDER_LINE_NOT_FOUND });
    });
  });

  it("lot missing → LOT_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ lot: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AssignLot, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: LOT_NOT_FOUND });
    });
  });

  it("lot site mismatch → LOT_SITE_MISMATCH", async () => {
    const fake = buildPrismaFake({
      lot: {
        id: LOT_ID,
        siteId: "other-site",
        lotNumber: "LOT-A1",
        expirationDate: new Date("2027-12-31"),
        status: LotStatus.ACTIVE,
        product: { ndc: NDC },
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AssignLot, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: LOT_SITE_MISMATCH });
    });
  });

  it("held lot → LOT_HELD", async () => {
    const fake = buildPrismaFake({
      lot: {
        id: LOT_ID,
        siteId: SITE_ID,
        lotNumber: "LOT-A1",
        expirationDate: new Date("2027-12-31"),
        status: LotStatus.ON_HOLD,
        product: { ndc: NDC },
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AssignLot, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: LOT_HELD });
    });
  });

  it("expired lot → LOT_EXPIRED", async () => {
    const fake = buildPrismaFake({
      lot: {
        id: LOT_ID,
        siteId: SITE_ID,
        lotNumber: "LOT-A1",
        expirationDate: new Date("2020-01-01"),
        status: LotStatus.ACTIVE,
        product: { ndc: NDC },
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AssignLot, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: LOT_EXPIRED });
    });
  });

  it("NDC mismatch → LOT_PRODUCT_MISMATCH", async () => {
    const fake = buildPrismaFake({
      lot: {
        id: LOT_ID,
        siteId: SITE_ID,
        lotNumber: "LOT-A1",
        expirationDate: new Date("2027-12-31"),
        status: LotStatus.ACTIVE,
        product: { ndc: "99999999999" },
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AssignLot, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: LOT_PRODUCT_MISMATCH });
    });
  });

  it("CAS miss → ORDER_VERSION_MISMATCH", async () => {
    const fake = buildPrismaFake({ orderUpdateManyCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AssignLot, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
  });
});
