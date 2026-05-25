// AddPrescription contract tests.
//
// Hand-rolled Prisma fake mirroring `create-order.test.ts`. The fake
// records every call so we can assert both the positive shape (lock
// → scope read → prescription scope → dup check → orderLine insert
// → version CAS → order_event seq=N+1 → audit → outbox) and the
// negative shape (each gate failure leaves zero `orderLine.create`,
// zero `auditLog.create`, zero `eventOutbox.createMany`).
//
// PHI invariant: no test fixture carries patient names, DOBs, drug
// names, or sigs. We use synthetic UUIDs throughout. The audit /
// outbox payload assertions explicitly check for the ABSENCE of
// those fields by name.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { OrderStatus, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { ADDABLE_STATES, AddPrescription } from "./add-prescription.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const PATIENT_ID = "00000000-0000-4000-8000-000000000004";
const RX_ID = "00000000-0000-4000-8000-000000000005";
const ORDER_ID = "00000000-0000-4000-8000-000000000006";
const POLICY_ID = "00000000-0000-4000-8000-000000000007";
const USER_ID = "00000000-0000-4000-8000-000000000008";
const ORDER_LINE_ID = "00000000-0000-4000-8000-0000000000aa";

const orgWideAddGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORDERS_ADD_PRESCRIPTION]),
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
  prescriptionId: RX_ID,
  quantityToFill: 60,
  daysSupplyToFill: 30,
  expectedOrderVersion: 1,
});

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  /** Status the locked order reports. Default RECEIVED. */
  orderStatus?: OrderStatus;
  /** Version the locked order reports. Default 1. */
  orderVersion?: number;
  /** If false, $queryRaw lock returns no rows. */
  orderLockFound?: boolean;
  /**
   * If false, `order.findFirst` (clinicId/patientId/siteId scope
   * read) returns null — defensive path the handler treats as
   * INTERNAL.
   */
  orderScopeFound?: boolean;
  /** If false, `prescription.findFirst` returns null. */
  prescriptionFound?: boolean;
  /** If non-null, `orderLine.findFirst` returns an existing line. */
  existingOrderLineId?: string | null;
  /** Existing order_event head sequenceNumber. Default 1 (CreateOrder wrote seq=1). */
  orderEventHeadSeq?: number | null;
  /** Count returned by `order.updateMany` (CAS). Default 1. */
  casCount?: number;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const orderStatus = overrides.orderStatus ?? OrderStatus.RECEIVED;
  const orderVersion = overrides.orderVersion ?? 1;
  const orderLockFound = overrides.orderLockFound ?? true;
  const orderScopeFound = overrides.orderScopeFound ?? true;
  const prescriptionFound = overrides.prescriptionFound ?? true;
  const existingOrderLineId = overrides.existingOrderLineId ?? null;
  // `??` would coerce a deliberate `null` (meaning "no prior events")
  // into the default — use `in` to preserve caller intent.
  const orderEventHeadSeq =
    "orderEventHeadSeq" in overrides ? (overrides.orderEventHeadSeq ?? null) : 1;
  const casCount = overrides.casCount ?? 1;

  const tx = {
    order: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "findFirst", args });
        return orderScopeFound
          ? { clinicId: CLINIC_ID, patientId: PATIENT_ID, siteId: SITE_ID }
          : null;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: casCount };
      }),
    },
    prescription: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "prescription", op: "findFirst", args });
        return prescriptionFound ? { id: RX_ID, status: "ACTIVE" } : null;
      }),
    },
    orderLine: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "findFirst", args });
        return existingOrderLineId === null ? null : { id: existingOrderLineId };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "create", args });
        return { id: ORDER_LINE_ID };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return orderEventHeadSeq === null ? null : { sequenceNumber: orderEventHeadSeq };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-2" };
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
    $queryRaw: vi.fn(async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      const joined = template.join("?");
      const isLock = /\bFROM\s+"?order"?\b/i.test(joined) && /\bFOR\s+UPDATE\b/i.test(joined);
      const op = isLock ? "select_for_update_order" : "raw";
      calls.push({
        table: "$queryRaw",
        op,
        args: { sql: joined, values: [...values] },
      });
      if (isLock) {
        return orderLockFound
          ? [
              {
                id: ORDER_ID,
                organizationId: ORG_ID,
                clinicId: CLINIC_ID,
                siteId: SITE_ID,
                currentStatus: orderStatus,
                version: orderVersion,
                workflowPolicyId: POLICY_ID,
                workflowPolicyVersion: 1,
              },
            ]
          : [];
      }
      return [];
    }),
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
    clock: clock.createFrozenClock(new Date("2026-05-23T16:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: orgWideAddGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

// ---------------------------------------------------------------------------
// ADDABLE_STATES sanity
// ---------------------------------------------------------------------------

describe("ADDABLE_STATES", () => {
  it("contains exactly RECEIVED, TYPING_IN_PROGRESS, TYPING_PENDING_MISSING_INFO", () => {
    expect(Array.from(ADDABLE_STATES).sort()).toEqual(
      [
        OrderStatus.RECEIVED,
        OrderStatus.TYPING_IN_PROGRESS,
        OrderStatus.TYPING_PENDING_MISSING_INFO,
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("AddPrescription — happy path", () => {
  it("returns {orderId, orderLineId, fromVersion, toVersion} and writes lock → scope → rx → dupcheck → orderLine → CAS → order_event(seq=2) → audit → outbox", async () => {
    const fake = buildPrismaFake({ orderEventHeadSeq: 1, orderVersion: 1 });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(AddPrescription, validInput(), { idempotencyKey: "add-1" })
    );

    expect(out).toEqual({
      orderId: ORDER_ID,
      orderLineId: ORDER_LINE_ID,
      fromVersion: 1,
      toVersion: 2,
    });

    // Lock fired and was scoped by id + organizationId.
    const locks = callsOf(fake.calls, "$queryRaw", "select_for_update_order");
    expect(locks).toHaveLength(1);
    const lockValues = (locks[0]!.args as { values: ReadonlyArray<unknown> }).values;
    expect(lockValues).toContain(ORDER_ID);
    expect(lockValues).toContain(ORG_ID);

    // Scope read on the order to recover clinicId / patientId.
    expect(callsOf(fake.calls, "order", "findFirst")).toHaveLength(1);

    // Prescription cross-check scoped to (org, clinic, patient).
    const rxCalls = callsOf(fake.calls, "prescription", "findFirst");
    expect(rxCalls).toHaveLength(1);
    expect((rxCalls[0]!.args as { where: unknown }).where).toMatchObject({
      id: RX_ID,
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      patientId: PATIENT_ID,
    });

    // Duplicate-line guard ran.
    expect(callsOf(fake.calls, "orderLine", "findFirst")).toHaveLength(1);

    // One OrderLine insert with correct scope + quantities.
    const lineCreate = callsOf(fake.calls, "orderLine", "create")[0];
    expect((lineCreate!.args as { data: Record<string, unknown> }).data).toMatchObject({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      orderId: ORDER_ID,
      prescriptionId: RX_ID,
      daysSupplyToFill: 30,
    });

    // CAS bumped version 1 → 2 with org scope.
    const cas = callsOf(fake.calls, "order", "updateMany");
    expect(cas).toHaveLength(1);
    expect((cas[0]!.args as { where: unknown; data: unknown }).where).toMatchObject({
      id: ORDER_ID,
      organizationId: ORG_ID,
      version: 1,
    });
    expect((cas[0]!.args as { where: unknown; data: unknown }).data).toEqual({ version: 2 });

    // order_event landed at seq=2 (head was 1).
    const oeCreates = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreates).toHaveLength(1);
    const oeData = (oeCreates[0]!.args as { data: Record<string, unknown> }).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.prescription.added.v1",
      sequenceNumber: 2,
      actorUserId: USER_ID,
    });

    // Bus wrote audit + outbox + idempotency in canonical order.
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });

  it("also adds when order is in TYPING_IN_PROGRESS", async () => {
    const fake = buildPrismaFake({ orderStatus: OrderStatus.TYPING_IN_PROGRESS });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AddPrescription, validInput(), { idempotencyKey: "add-2" })
      ).resolves.toMatchObject({ orderLineId: ORDER_LINE_ID });
    });
  });

  it("also adds when order is in TYPING_PENDING_MISSING_INFO", async () => {
    const fake = buildPrismaFake({ orderStatus: OrderStatus.TYPING_PENDING_MISSING_INFO });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AddPrescription, validInput(), { idempotencyKey: "add-3" })
      ).resolves.toMatchObject({ orderLineId: ORDER_LINE_ID });
    });
  });

  it("computes the right order_event seq even when head is null (theoretical: order with zero prior events)", async () => {
    const fake = buildPrismaFake({ orderEventHeadSeq: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(AddPrescription, validInput(), { idempotencyKey: "add-4" })
    );

    const oeData = (
      callsOf(fake.calls, "orderEvent", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(oeData["sequenceNumber"]).toBe(1);
  });

  it("audit metadata + outbox payload contain no patient/drug PHI substrings", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(AddPrescription, validInput(), { idempotencyKey: "add-5" })
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    const auditJson = JSON.stringify(auditData, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v
    );
    for (const banned of ["firstName", "lastName", "dateOfBirth", "drugName", "ndc", "sig"]) {
      expect(auditJson).not.toContain(banned);
    }

    const outboxRow = (
      callsOf(fake.calls, "eventOutbox", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data[0]!;
    expect(outboxRow).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.prescription.added.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    const payload = outboxRow["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      siteId: SITE_ID,
      prescriptionId: RX_ID,
      orderLineId: ORDER_LINE_ID,
      quantityToFill: 60,
      daysSupplyToFill: 30,
      fromVersion: 1,
      toVersion: 2,
      occurredAt: "2026-05-23T16:00:00.000Z",
    });
    const payloadJson = JSON.stringify(payload);
    for (const banned of ["firstName", "lastName", "dateOfBirth", "drugName", "ndc", "sig"]) {
      expect(payloadJson).not.toContain(banned);
    }
  });

  it("audit metadata carries the version transition (fromVersion → toVersion)", async () => {
    const fake = buildPrismaFake({ orderVersion: 3 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        AddPrescription,
        { ...validInput(), expectedOrderVersion: 3 },
        { idempotencyKey: "add-6" }
      )
    );

    const auditData = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    const meta = auditData["metadata"] as Record<string, unknown>;
    expect(meta).toMatchObject({
      orderId: ORDER_ID,
      prescriptionId: RX_ID,
      orderLineId: ORDER_LINE_ID,
      clinicId: CLINIC_ID,
      fromVersion: 3,
      toVersion: 4,
      quantityToFill: 60,
      daysSupplyToFill: 30,
    });
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("AddPrescription — input validation", () => {
  it.each([
    ["bad orderId UUID", { orderId: "not-a-uuid" } as Partial<ReturnType<typeof validInput>>],
    [
      "bad prescriptionId UUID",
      { prescriptionId: "not-a-uuid" } as Partial<ReturnType<typeof validInput>>,
    ],
    ["zero quantityToFill", { quantityToFill: 0 } as Partial<ReturnType<typeof validInput>>],
    ["negative quantityToFill", { quantityToFill: -1 } as Partial<ReturnType<typeof validInput>>],
    ["zero daysSupplyToFill", { daysSupplyToFill: 0 } as Partial<ReturnType<typeof validInput>>],
    [
      "negative daysSupplyToFill",
      { daysSupplyToFill: -1 } as Partial<ReturnType<typeof validInput>>,
    ],
    [
      "negative expectedOrderVersion",
      { expectedOrderVersion: -1 } as Partial<ReturnType<typeof validInput>>,
    ],
    [
      "non-integer daysSupplyToFill",
      { daysSupplyToFill: 1.5 } as Partial<ReturnType<typeof validInput>>,
    ],
  ])("rejects %s as COMMAND_INPUT_INVALID", async (_label, override) => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AddPrescription, { ...validInput(), ...override }, { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderLine", "create")).toHaveLength(0);
  });

  it("rejects extra fields (strict)", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AddPrescription, { ...validInput(), sneaky: "x" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------------
// State + concurrency failures
// ---------------------------------------------------------------------------

describe("AddPrescription — state + concurrency failures", () => {
  it("order missing (lock returns no row) → ORDER_NOT_FOUND, no downstream writes", async () => {
    const fake = buildPrismaFake({ orderLockFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AddPrescription, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "orderLine", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it.each([
    OrderStatus.TYPED_READY_FOR_PV1,
    OrderStatus.PV1_IN_PROGRESS,
    OrderStatus.PV1_APPROVED_READY_FOR_FILL,
    OrderStatus.FILL_IN_PROGRESS,
    OrderStatus.READY_TO_SHIP,
    OrderStatus.SHIPPED,
    OrderStatus.ON_HOLD,
    OrderStatus.CANCELLED,
  ])(
    "order in non-addable state %s → ORDER_NOT_IN_ADDABLE_STATE, no orderLine/CAS/audit/outbox",
    async (status) => {
      const fake = buildPrismaFake({ orderStatus: status });
      configureBus(fake.client);

      await withTenancyContext(ctxFor(), async () => {
        await expect(
          executeCommand(AddPrescription, validInput(), { idempotencyKey: "k" })
        ).rejects.toMatchObject({
          code: "ORDER_NOT_IN_ADDABLE_STATE",
          metadata: { orderId: ORDER_ID, currentStatus: status },
        });
      });
      expect(callsOf(fake.calls, "orderLine", "create")).toHaveLength(0);
      expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
      expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
      expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
    }
  );

  it("caller's expectedOrderVersion stale → ORDER_VERSION_MISMATCH with both versions in metadata", async () => {
    const fake = buildPrismaFake({ orderVersion: 5 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          AddPrescription,
          { ...validInput(), expectedOrderVersion: 3 },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({
        code: "ORDER_VERSION_MISMATCH",
        metadata: { expectedVersion: 3, actualVersion: 5, orderId: ORDER_ID },
      });
    });
    expect(callsOf(fake.calls, "orderLine", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("prescription not in (org, clinic, patient) → ORDER_PRESCRIPTION_MISMATCH", async () => {
    const fake = buildPrismaFake({ prescriptionFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AddPrescription, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({
        code: "ORDER_PRESCRIPTION_MISMATCH",
        metadata: { prescriptionId: RX_ID, orderId: ORDER_ID },
      });
    });
    expect(callsOf(fake.calls, "orderLine", "create")).toHaveLength(0);
  });

  it("prescription already on order → ORDER_PRESCRIPTION_ALREADY_ON_ORDER with existing line id", async () => {
    const fake = buildPrismaFake({ existingOrderLineId: "existing-line-99" });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AddPrescription, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({
        code: "ORDER_PRESCRIPTION_ALREADY_ON_ORDER",
        metadata: {
          orderId: ORDER_ID,
          prescriptionId: RX_ID,
          existingOrderLineId: "existing-line-99",
        },
      });
    });
    expect(callsOf(fake.calls, "orderLine", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tenancy / RBAC
// ---------------------------------------------------------------------------

describe("AddPrescription — tenancy + RBAC", () => {
  it("no tenancy frame → TENANCY_NO_CONTEXT, zero DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(AddPrescription, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderLine", "create")).toHaveLength(0);
  });

  it("missing ORDERS_ADD_PRESCRIPTION → PERMISSION_DENIED, no row lock", async () => {
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
              permissions: new Set([PERMISSIONS.ORDERS_READ]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AddPrescription, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "orderLine", "create")).toHaveLength(0);
  });
});
