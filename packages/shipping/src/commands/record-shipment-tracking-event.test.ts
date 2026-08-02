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
    pickedUpAt?: Date | null;
    deliveredAt?: Date | null;
  } | null;
  createThrows?: Error | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const defaultShipmentRow = {
    id: SHIPMENT_ID,
    orderId: ORDER_ID,
    siteId: SITE_ID,
    status: ShipmentStatus.CONFIRMED,
    lastTrackingEventAt: null,
    lastTrackingEventKind: null,
    pickedUpAt: null,
    deliveredAt: null,
  };
  const shipmentRow =
    overrides.shipment === undefined
      ? defaultShipmentRow
      : overrides.shipment === null
        ? null
        : { pickedUpAt: null, deliveredAt: null, ...overrides.shipment };
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
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "findUnique", args });
        return null;
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
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
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

  it("persists scan location on the event row and refreshes the delivery estimate — both kept out of audit/outbox", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordShipmentTrackingEvent,
        deliveredInput({
          source: ShipmentTrackingSource.FEDEX,
          externalEventId: "fedex:794665654567:scan:DL:2026-05-24T18:00:00.000Z",
          scanCity: "MEMPHIS",
          scanStateOrProvince: "TN",
          scanCountry: "US",
          estimatedDeliveryAt: "2026-05-25T20:00:00.000Z",
        }),
        { idempotencyKey: "fedex-poll:scan-loc-1" }
      )
    );

    const insert = callsOf(fake.calls, "shipmentTrackingEvent", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(insert.data).toMatchObject({
      scanCity: "MEMPHIS",
      scanStateOrProvince: "TN",
      scanCountry: "US",
    });

    const shipmentUpdate = callsOf(fake.calls, "shipment", "update")[0]!.args as {
      data: Record<string, unknown>;
    };
    expect(shipmentUpdate.data["estimatedDeliveryAt"]).toEqual(
      new Date("2026-05-25T20:00:00.000Z")
    );

    // Location must not leak into audit metadata or the outbox payload.
    const stringify = (v: unknown): string =>
      JSON.stringify(v, (_k, val: unknown) => (typeof val === "bigint" ? val.toString() : val));
    const auditArgs = callsOf(fake.calls, "auditLog", "create")[0]!.args;
    expect(stringify(auditArgs)).not.toContain("MEMPHIS");
    const outboxArgs = callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args;
    expect(stringify(outboxArgs)).not.toContain("MEMPHIS");
  });

  it("does NOT clobber the cached delivery estimate from an out-of-order older event", async () => {
    const fake = buildPrismaFake({
      shipment: {
        id: SHIPMENT_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        status: ShipmentStatus.IN_TRANSIT,
        lastTrackingEventAt: new Date("2026-05-24T20:00:00.000Z"),
        lastTrackingEventKind: ShipmentTrackingEventKind.IN_TRANSIT,
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordShipmentTrackingEvent,
        deliveredInput({
          kind: ShipmentTrackingEventKind.IN_TRANSIT,
          carrierStatus: "in_transit",
          externalEventId: "evt_backfill_1",
          occurredAt: "2026-05-24T10:00:00.000Z", // older than the cached event
          estimatedDeliveryAt: "2026-05-26T00:00:00.000Z",
        }),
        { idempotencyKey: "easypost:evt_backfill_1" }
      )
    );

    // Older event → the estimate must NOT be clobbered. The event
    // does stamp `pickedUpAt` (first observed movement), but that
    // endpoint-only update carries no estimate, no status, and no
    // heartbeat.
    const updates = callsOf(fake.calls, "shipment", "update");
    expect(updates).toHaveLength(1);
    const updateData = (updates[0]!.args as { data: Record<string, unknown> }).data;
    expect(updateData).not.toHaveProperty("estimatedDeliveryAt");
    expect(updateData).not.toHaveProperty("status");
    expect(updateData).not.toHaveProperty("lastTrackingEventAt");
  });
});

describe("RecordShipmentTrackingEvent — pickup-to-delivery transit", () => {
  it("stamps pickedUpAt on the first movement scan without setting transitSeconds", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordShipmentTrackingEvent,
        deliveredInput({
          kind: ShipmentTrackingEventKind.IN_TRANSIT,
          carrierStatus: "PU",
          externalEventId: "evt_pickup_1",
          occurredAt: "2026-05-24T12:00:00.000Z",
        }),
        { idempotencyKey: "fedex-poll:evt_pickup_1" }
      )
    );

    const updateData = (
      callsOf(fake.calls, "shipment", "update")[0]!.args as { data: Record<string, unknown> }
    ).data;
    expect(updateData["pickedUpAt"]).toEqual(new Date("2026-05-24T12:00:00.000Z"));
    expect(updateData["deliveredAt"]).toBeNull();
    expect(updateData["transitSeconds"]).toBeNull();
  });

  it("stamps deliveredAt on the DELIVERED scan and computes transitSeconds from pickedUpAt", async () => {
    const fake = buildPrismaFake({
      shipment: {
        id: SHIPMENT_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        status: ShipmentStatus.IN_TRANSIT,
        lastTrackingEventAt: new Date("2026-05-24T12:00:00.000Z"),
        lastTrackingEventKind: ShipmentTrackingEventKind.IN_TRANSIT,
        pickedUpAt: new Date("2026-05-24T12:00:00.000Z"),
        deliveredAt: null,
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordShipmentTrackingEvent,
        deliveredInput({
          externalEventId: "evt_delivered_1",
          occurredAt: "2026-05-25T15:30:00.000Z", // 27.5h after pickup
        }),
        { idempotencyKey: "fedex-poll:evt_delivered_1" }
      )
    );

    const updateData = (
      callsOf(fake.calls, "shipment", "update")[0]!.args as { data: Record<string, unknown> }
    ).data;
    expect(updateData["deliveredAt"]).toEqual(new Date("2026-05-25T15:30:00.000Z"));
    expect(updateData["transitSeconds"]).toBe(27.5 * 3600);
    // The delivered event also advances the cached status.
    expect(updateData["status"]).toBe(ShipmentStatus.DELIVERED);
  });

  it("pulls pickedUpAt BACK on an out-of-order earlier movement scan and recomputes transit", async () => {
    // Shipment already delivered; a backfilled scan reveals pickup
    // happened 6h earlier than previously known. The event is older
    // than the cached last event (no status/heartbeat change) but the
    // transit endpoints must still move.
    const fake = buildPrismaFake({
      shipment: {
        id: SHIPMENT_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        status: ShipmentStatus.DELIVERED,
        lastTrackingEventAt: new Date("2026-05-25T15:30:00.000Z"),
        lastTrackingEventKind: ShipmentTrackingEventKind.DELIVERED,
        pickedUpAt: new Date("2026-05-24T12:00:00.000Z"),
        deliveredAt: new Date("2026-05-25T15:30:00.000Z"),
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordShipmentTrackingEvent,
        deliveredInput({
          kind: ShipmentTrackingEventKind.IN_TRANSIT,
          carrierStatus: "PU",
          externalEventId: "evt_backfill_pickup_1",
          occurredAt: "2026-05-24T06:00:00.000Z",
        }),
        { idempotencyKey: "fedex-poll:evt_backfill_pickup_1" }
      )
    );

    const updateData = (
      callsOf(fake.calls, "shipment", "update")[0]!.args as { data: Record<string, unknown> }
    ).data;
    expect(updateData["pickedUpAt"]).toEqual(new Date("2026-05-24T06:00:00.000Z"));
    expect(updateData["transitSeconds"]).toBe(33.5 * 3600); // 6h more than before
    // Endpoint-only update: no status, no heartbeat.
    expect(updateData).not.toHaveProperty("status");
    expect(updateData).not.toHaveProperty("lastTrackingEventAt");
  });

  it("does NOT move endpoints for later duplicate-ish scans (min semantics)", async () => {
    const fake = buildPrismaFake({
      shipment: {
        id: SHIPMENT_ID,
        orderId: ORDER_ID,
        siteId: SITE_ID,
        status: ShipmentStatus.IN_TRANSIT,
        lastTrackingEventAt: new Date("2026-05-24T12:00:00.000Z"),
        lastTrackingEventKind: ShipmentTrackingEventKind.IN_TRANSIT,
        pickedUpAt: new Date("2026-05-24T12:00:00.000Z"),
        deliveredAt: null,
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordShipmentTrackingEvent,
        deliveredInput({
          kind: ShipmentTrackingEventKind.IN_TRANSIT,
          carrierStatus: "AR",
          externalEventId: "evt_later_scan_1",
          occurredAt: "2026-05-24T18:00:00.000Z", // later movement scan
        }),
        { idempotencyKey: "fedex-poll:evt_later_scan_1" }
      )
    );

    // Strictly-newer heartbeat update happens, but pickedUpAt is not
    // pushed forward by the later scan.
    const updateData = (
      callsOf(fake.calls, "shipment", "update")[0]!.args as { data: Record<string, unknown> }
    ).data;
    expect(updateData).not.toHaveProperty("pickedUpAt");
    expect(updateData).not.toHaveProperty("transitSeconds");
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
    // The older IN_TRANSIT scan is this shipment's first observed
    // movement, so it stamps `pickedUpAt` — but as an ENDPOINT-ONLY
    // update: status and heartbeat must not move.
    const updates = callsOf(fake.calls, "shipment", "update");
    expect(updates).toHaveLength(1);
    const updateData = (updates[0]!.args as { data: Record<string, unknown> }).data;
    expect(updateData).not.toHaveProperty("status");
    expect(updateData).not.toHaveProperty("lastTrackingEventAt");
    expect(updateData["pickedUpAt"]).toEqual(new Date("2026-05-24T10:00:00.000Z"));
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
