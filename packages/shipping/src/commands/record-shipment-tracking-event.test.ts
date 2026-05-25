// RecordShipmentTrackingEvent contract tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  Prisma,
  RoleScope,
  ShipmentStatus,
  ShipmentTrackingEventKind,
  ShipmentTrackingSource,
} from "@pharmax/database";
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
  RecordShipmentTrackingEvent,
  SHIPMENT_TRACKING_DUPLICATE_EVENT,
  SHIPMENT_TRACKING_SHIPMENT_NOT_FOUND,
} from "./record-shipment-tracking-event.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const SHIPMENT_ID = "00000000-0000-4000-8000-0000000000ee";
const USER_ID = "00000000-0000-4000-8000-000000000009";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.SHIP_RECORD_TRACKING_EVENT]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

const occurredAt = "2026-05-24T18:00:00.000Z";
const signatureVerifiedAt = "2026-05-24T18:00:01.000Z";

function deliveredInput(overrides: Record<string, unknown> = {}) {
  return {
    shipmentId: SHIPMENT_ID,
    source: ShipmentTrackingSource.EASYPOST,
    externalEventId: "evt_easypost_1",
    kind: ShipmentTrackingEventKind.DELIVERED,
    carrierStatus: "delivered",
    occurredAt,
    signatureVerifiedAt,
    rawPayload: { id: "evt_easypost_1", result: { status: "delivered" } },
    ...overrides,
  };
}

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  shipment?: {
    id: string;
    orderId: string;
    siteId: string;
    status: ShipmentStatus;
    lastTrackingEventAt: Date | null;
    lastTrackingEventKind: ShipmentTrackingEventKind | null;
  } | null;
  createThrows?: Error | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const shipmentRow =
    overrides.shipment === undefined
      ? {
          id: SHIPMENT_ID,
          orderId: ORDER_ID,
          siteId: SITE_ID,
          status: ShipmentStatus.CONFIRMED,
          lastTrackingEventAt: null,
          lastTrackingEventKind: null,
        }
      : overrides.shipment;
  const createThrows = overrides.createThrows ?? null;

  const tx = {
    shipment: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "shipment", op: "findFirst", args });
        return shipmentRow;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "shipment", op: "update", args });
        return { id: SHIPMENT_ID };
      }),
    },
    shipmentTrackingEvent: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "shipmentTrackingEvent", op: "create", args });
        if (createThrows !== null) {
          throw createThrows;
        }
        return { id: "ste-1" };
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
    clock: clock.createFrozenClock(new Date("2026-05-24T18:00:02.000Z")),
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

describe("RecordShipmentTrackingEvent — happy path", () => {
  it("inserts event, advances shipment status, emits outbox", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RecordShipmentTrackingEvent, deliveredInput(), {
        idempotencyKey: "easypost:evt_easypost_1",
      })
    );

    expect(out).toMatchObject({
      shipmentId: SHIPMENT_ID,
      orderId: ORDER_ID,
      applied: true,
      cachedStatusAdvanced: true,
    });

    const insert = callsOf(fake.calls, "shipmentTrackingEvent", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(insert.data).toMatchObject({
      organizationId: ORG_ID,
      shipmentId: SHIPMENT_ID,
      source: ShipmentTrackingSource.EASYPOST,
      externalEventId: "evt_easypost_1",
      kind: ShipmentTrackingEventKind.DELIVERED,
      carrierStatus: "delivered",
    });

    const shipmentUpdate = callsOf(fake.calls, "shipment", "update")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(shipmentUpdate.data).toMatchObject({
      status: ShipmentStatus.DELIVERED,
      lastTrackingEventKind: ShipmentTrackingEventKind.DELIVERED,
    });

    const outboxRows = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(outboxRows[0]).toMatchObject({
      eventType: "shipment.tracking.recorded.v1",
      aggregateType: "Shipment",
      aggregateId: SHIPMENT_ID,
    });
  });
});

describe("RecordShipmentTrackingEvent — newer-only advancement", () => {
  it("does NOT roll the shipment status back when an older IN_TRANSIT event arrives after DELIVERED", async () => {
    const fake = buildPrismaFake({
      shipment: {
        id: SHIPMENT_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        status: ShipmentStatus.DELIVERED,
        lastTrackingEventAt: new Date("2026-05-24T20:00:00.000Z"),
        lastTrackingEventKind: ShipmentTrackingEventKind.DELIVERED,
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordShipmentTrackingEvent,
        deliveredInput({
          kind: ShipmentTrackingEventKind.IN_TRANSIT,
          carrierStatus: "in_transit",
          externalEventId: "evt_older_1",
          occurredAt: "2026-05-24T10:00:00.000Z",
        }),
        { idempotencyKey: "easypost:evt_older_1" }
      )
    );

    expect(out.applied).toBe(true);
    expect(out.cachedStatusAdvanced).toBe(false);
    expect(callsOf(fake.calls, "shipment", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "shipmentTrackingEvent", "create")).toHaveLength(1);
  });

  it("updates the heartbeat timestamp for newer UNKNOWN events but leaves status alone", async () => {
    const fake = buildPrismaFake({
      shipment: {
        id: SHIPMENT_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        status: ShipmentStatus.IN_TRANSIT,
        lastTrackingEventAt: new Date("2026-05-24T10:00:00.000Z"),
        lastTrackingEventKind: ShipmentTrackingEventKind.IN_TRANSIT,
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordShipmentTrackingEvent,
        deliveredInput({
          kind: ShipmentTrackingEventKind.UNKNOWN,
          carrierStatus: "unknown",
          externalEventId: "evt_unknown_1",
        }),
        { idempotencyKey: "easypost:evt_unknown_1" }
      )
    );

    expect(out.cachedStatusAdvanced).toBe(false);
    const updateData = (
      callsOf(fake.calls, "shipment", "update")[0]!.args as { data: Record<string, unknown> }
    ).data;
    expect(updateData).not.toHaveProperty("status");
    expect(updateData).toMatchObject({
      lastTrackingEventKind: ShipmentTrackingEventKind.UNKNOWN,
    });
  });
});

describe("RecordShipmentTrackingEvent — idempotency", () => {
  it("translates a Prisma P2002 unique violation into SHIPMENT_TRACKING_DUPLICATE_EVENT", async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate", {
      code: "P2002",
      clientVersion: "test",
    });
    const fake = buildPrismaFake({ createThrows: duplicate });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RecordShipmentTrackingEvent, deliveredInput(), {
          idempotencyKey: "easypost:evt_dup_1",
        })
      ).rejects.toMatchObject({ code: SHIPMENT_TRACKING_DUPLICATE_EVENT });
    });
  });
});

describe("RecordShipmentTrackingEvent — not found", () => {
  it("throws SHIPMENT_TRACKING_SHIPMENT_NOT_FOUND when the shipment is missing", async () => {
    const fake = buildPrismaFake({ shipment: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RecordShipmentTrackingEvent, deliveredInput(), {
          idempotencyKey: "easypost:evt_missing_1",
        })
      ).rejects.toMatchObject({ code: SHIPMENT_TRACKING_SHIPMENT_NOT_FOUND });
    });
    expect(callsOf(fake.calls, "shipmentTrackingEvent", "create")).toHaveLength(0);
  });
});
