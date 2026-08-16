// DispenseRefill contract tests.
//
// Runs against a hand-rolled Prisma fake (same pattern as
// `create-order.test.ts`) so the suite is DB-free. The tests assert
// both the positive shape (the guarded decrement, the refill order,
// the events) and the negative shape (every declared error code, and
// that no DB footprint remains after each refusal).
//
// PHI invariant: no test fixture carries patient names or DOBs.
// We exercise the command with synthetic UUIDs only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  ControlledSubstanceSchedule,
  OrderPriority,
  PatientStatus,
  PrescriptionStatus,
  Prisma,
  RoleScope,
} from "@pharmax/database";
import { DEFAULT_END_TO_END_SLA_BUDGET_MS } from "@pharmax/sla";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { DispenseRefill } from "./dispense-refill.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const PATIENT_ID = "00000000-0000-4000-8000-000000000004";
const RX_ID = "00000000-0000-4000-8000-000000000005";
const BUCKET_ID = "00000000-0000-4000-8000-000000000007";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const LINE_ID = "00000000-0000-4000-8000-0000000000bb";

// Frozen bus clock (see configureBus): 2026-05-23T12:00:00Z.
const FROZEN_NOW = "2026-05-23T12:00:00.000Z";

const orgWideCreateGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORDERS_CREATE]),
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
  prescriptionId: RX_ID,
  siteId: SITE_ID,
  priority: OrderPriority.NORMAL,
});

interface PrescriptionRow {
  id: string;
  clinicId: string;
  patientId: string;
  status: PrescriptionStatus;
  rxNumber: string;
  drugNdc: string;
  quantityAuthorized: Prisma.Decimal;
  daysSupply: number;
  refillsAuthorized: number;
  refillsRemaining: number;
  originalDateWritten: Date;
  expiresAt: Date;
  controlledSubstanceSchedule: ControlledSubstanceSchedule;
}

/** Non-controlled, 3 of 5 refills left, alive for another year. */
function basePrescription(): PrescriptionRow {
  return {
    id: RX_ID,
    clinicId: CLINIC_ID,
    patientId: PATIENT_ID,
    status: PrescriptionStatus.ACTIVE,
    rxNumber: "0000042",
    drugNdc: "00071015523",
    quantityAuthorized: new Prisma.Decimal("30"),
    daysSupply: 30,
    refillsAuthorized: 5,
    refillsRemaining: 3,
    originalDateWritten: new Date("2026-04-01T00:00:00.000Z"),
    expiresAt: new Date("2027-04-01T00:00:00.000Z"),
    controlledSubstanceSchedule: ControlledSubstanceSchedule.NON_CONTROLLED,
  };
}

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  /** Row `prescription.findFirst` returns (null = not found). */
  prescription?: PrescriptionRow | null;
  /** Patient status (default ACTIVE). Null = patient row missing. */
  patientStatus?: PatientStatus | null;
  /** Row the in-flight `orderLine.findFirst` guard returns. */
  inFlightOrderId?: string | null;
  /** If false, `pharmacySite.findFirst` returns null. */
  siteFound?: boolean;
  /** If false, `clinicSite.findFirst` returns null. */
  clinicSiteLinked?: boolean;
  /** Count `prescription.updateMany` reports (default 1). */
  decrementCount?: number;
  /** If false, `bucket.findFirst` returns null. */
  intakeBucketFound?: boolean;
  /** If false, `workflowPolicy.findUnique` returns null. */
  policyFound?: boolean;
  /** Policy status (default "ACTIVE"). */
  policyStatus?: string;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const prescription =
    overrides.prescription === undefined ? basePrescription() : overrides.prescription;
  const patientStatus =
    overrides.patientStatus === undefined ? PatientStatus.ACTIVE : overrides.patientStatus;
  const inFlightOrderId = overrides.inFlightOrderId ?? null;
  const siteFound = overrides.siteFound ?? true;
  const clinicSiteLinked = overrides.clinicSiteLinked ?? true;
  const decrementCount = overrides.decrementCount ?? 1;
  const intakeBucketFound = overrides.intakeBucketFound ?? true;
  const policyFound = overrides.policyFound ?? true;
  const policyStatus = overrides.policyStatus ?? "ACTIVE";

  const tx = {
    prescription: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "prescription", op: "findFirst", args });
        return prescription;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "prescription", op: "updateMany", args });
        return { count: decrementCount };
      }),
    },
    patient: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "patient", op: "findFirst", args });
        return patientStatus === null ? null : { id: PATIENT_ID, status: patientStatus };
      }),
    },
    orderLine: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "findFirst", args });
        return inFlightOrderId === null ? null : { orderId: inFlightOrderId };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "create", args });
        return { id: LINE_ID };
      }),
    },
    pharmacySite: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmacySite", op: "findFirst", args });
        return siteFound ? { id: SITE_ID } : null;
      }),
    },
    clinicSite: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinicSite", op: "findFirst", args });
        return clinicSiteLinked ? { id: "link-1" } : null;
      }),
    },
    bucket: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findFirst", args });
        return intakeBucketFound ? { id: BUCKET_ID } : null;
      }),
    },
    workflowPolicy: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "findUnique", args });
        return policyFound
          ? { id: POLICY_ID, code: "order.standard", version: 1, status: policyStatus }
          : null;
      }),
    },
    order: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "create", args });
        return { id: ORDER_ID };
      }),
    },
    orderStageInterval: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderStageInterval", op: "findFirst", args });
        return null;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderStageInterval", op: "create", args });
        return { id: "interval-1" };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return null;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-1" };
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

/** Asserts the refusal left no order, audit, or outbox footprint. */
function expectNoWriteFootprint(calls: FakeCall[]): void {
  expect(callsOf(calls, "order", "create")).toHaveLength(0);
  expect(callsOf(calls, "orderLine", "create")).toHaveLength(0);
  expect(callsOf(calls, "auditLog", "create")).toHaveLength(0);
  expect(callsOf(calls, "eventOutbox", "createMany")).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date(FROZEN_NOW)),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: orgWideCreateGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("DispenseRefill — happy path", () => {
  it("decrements under guard and writes order + line + order_event + audit + outbox", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(DispenseRefill, validInput(), { idempotencyKey: "refill-1" })
    );

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      orderLineId: LINE_ID,
      prescriptionId: RX_ID,
      // 5 authorized, 3 remaining before → refills 1 and 2 already
      // consumed → this is refill 3, with 2 left afterwards.
      refillNumber: 3,
      refillsRemaining: 2,
      currentStatus: "RECEIVED",
      version: 0,
    });

    // The decrement is a GUARDED atomic update: WHERE re-asserts
    // active status and a positive counter, so a stale validation
    // read can never over-decrement.
    const decrement = callsOf(fake.calls, "prescription", "updateMany")[0];
    expect(decrement).toBeDefined();
    expect(decrement!.args).toMatchObject({
      where: {
        id: RX_ID,
        organizationId: ORG_ID,
        status: PrescriptionStatus.ACTIVE,
        refillsRemaining: { gt: 0 },
      },
      data: { refillsRemaining: { decrement: 1 } },
    });

    // Refill order lands at RECEIVED with policy stamps, the intake
    // bucket, and a refill provenance marker.
    const orderCreate = callsOf(fake.calls, "order", "create")[0];
    const orderData = (orderCreate!.args as { data: Record<string, unknown> }).data;
    expect(orderData).toMatchObject({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      siteId: SITE_ID,
      patientId: PATIENT_ID,
      currentStatus: "RECEIVED",
      currentBucketId: BUCKET_ID,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
      version: 0,
      priority: "NORMAL",
      intakeSourceKind: "MANUAL",
      intakeSourceRefId: `refill:${RX_ID}`,
    });

    // SLA deadline computed at intake, same as CreateOrder.
    const receivedAt = orderData["receivedAt"] as Date;
    const slaDeadlineAt = orderData["slaDeadlineAt"] as Date;
    expect(slaDeadlineAt.getTime()).toBe(receivedAt.getTime() + DEFAULT_END_TO_END_SLA_BUDGET_MS);

    // One line, re-dispensing the authorized per-fill quantity.
    const lineCreate = callsOf(fake.calls, "orderLine", "create")[0];
    expect((lineCreate!.args as { data: Record<string, unknown> }).data).toMatchObject({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      orderId: ORDER_ID,
      prescriptionId: RX_ID,
      daysSupplyToFill: 30,
    });

    // WAIT_BEFORE_TYPING interval opened.
    const intervalCreate = callsOf(fake.calls, "orderStageInterval", "create")[0];
    expect((intervalCreate!.args as { data: Record<string, unknown> }).data).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      kind: "WAIT_BEFORE_TYPING",
    });

    // Factory wrote order_event seq=1; bus wrote audit + outbox +
    // idempotency.
    const oeCreate = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreate).toHaveLength(1);
    expect((oeCreate[0]!.args as { data: Record<string, unknown> }).data).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      eventType: "order.received.v1",
      sequenceNumber: 1,
      actorUserId: USER_ID,
    });
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });

  it("emits order.received.v1 with the same payload shape CreateOrder emits", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(DispenseRefill, validInput(), { idempotencyKey: "refill-2" })
    );

    const outboxCall = callsOf(fake.calls, "eventOutbox", "createMany")[0];
    const rows = (outboxCall!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.received.v1",
      aggregateType: "Order",
      aggregateId: ORDER_ID,
    });
    expect(rows[0]?.["payload"]).toMatchObject({
      orderId: ORDER_ID,
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      siteId: SITE_ID,
      patientId: PATIENT_ID,
      priority: "NORMAL",
      intakeSourceKind: "MANUAL",
      lineCount: 1,
      occurredAt: FROZEN_NOW,
    });
  });

  it("audit row records the refill on the Prescription aggregate with NO patient identifiers", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(DispenseRefill, validInput(), { idempotencyKey: "refill-3" })
    );

    const auditCall = callsOf(fake.calls, "auditLog", "create")[0];
    const auditData = (auditCall!.args as { data: Record<string, unknown> }).data;
    expect(auditData).toMatchObject({
      action: "prescription.refill_dispensed",
      resourceType: "Prescription",
      resourceId: RX_ID,
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      orderId: ORDER_ID,
      clinicId: CLINIC_ID,
      siteId: SITE_ID,
      rxNumber: "0000042",
      drugNdc: "00071015523",
      controlledSubstanceSchedule: "NON_CONTROLLED",
      refillNumber: 3,
      refillsRemaining: 2,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
    });
    expect(metadata["patientId"]).toBeUndefined();
    expect(metadata["firstName"]).toBeUndefined();
    expect(metadata["dateOfBirth"]).toBeUndefined();
    expect(metadata["sig"]).toBeUndefined();
  });

  it("allows a refill on the expiry day itself", async () => {
    const rx = basePrescription();
    rx.expiresAt = new Date("2026-05-23T00:00:00.000Z"); // = frozen "today"
    const fake = buildPrismaFake({ prescription: rx });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(DispenseRefill, validInput(), { idempotencyKey: "refill-4" })
    );
    expect(out.orderId).toBe(ORDER_ID);
  });

  it("allows a CIII refill inside the six-month horizon", async () => {
    const rx = basePrescription();
    rx.controlledSubstanceSchedule = ControlledSubstanceSchedule.CIII;
    rx.refillsAuthorized = 5;
    rx.refillsRemaining = 5;
    rx.originalDateWritten = new Date("2026-04-01T00:00:00.000Z");
    rx.expiresAt = new Date("2026-10-01T00:00:00.000Z");
    const fake = buildPrismaFake({ prescription: rx });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(DispenseRefill, validInput(), { idempotencyKey: "refill-5" })
    );
    expect(out.refillNumber).toBe(1);
    expect(out.refillsRemaining).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("DispenseRefill — input validation", () => {
  it("rejects bad prescriptionId UUID with no DB reads", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          DispenseRefill,
          { ...validInput(), prescriptionId: "not-a-uuid" },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "prescription", "findFirst")).toHaveLength(0);
    expectNoWriteFootprint(fake.calls);
  });

  it("rejects bad siteId UUID", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, { ...validInput(), siteId: "nope" }, { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects extra fields (strict schema)", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, { ...validInput(), quantityToFill: 90 } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------------
// Refusals — every declared error code
// ---------------------------------------------------------------------------

describe("DispenseRefill — refusals", () => {
  it("prescription missing → REFILL_PRESCRIPTION_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ prescription: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "REFILL_PRESCRIPTION_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "prescription", "updateMany")).toHaveLength(0);
    expectNoWriteFootprint(fake.calls);
  });

  it("prescription not ACTIVE → REFILL_PRESCRIPTION_NOT_ACTIVE", async () => {
    const rx = basePrescription();
    rx.status = PrescriptionStatus.DISCONTINUED;
    const fake = buildPrismaFake({ prescription: rx });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "REFILL_PRESCRIPTION_NOT_ACTIVE" });
    });
    expect(callsOf(fake.calls, "prescription", "updateMany")).toHaveLength(0);
    expectNoWriteFootprint(fake.calls);
  });

  it("patient not ACTIVE → REFILL_PATIENT_NOT_ACTIVE", async () => {
    const fake = buildPrismaFake({ patientStatus: PatientStatus.INACTIVE });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "REFILL_PATIENT_NOT_ACTIVE" });
    });
    expectNoWriteFootprint(fake.calls);
  });

  it("Schedule II → REFILL_SCHEDULE_II_PROHIBITED with the CFR citation, before any counter check", async () => {
    const rx = basePrescription();
    rx.controlledSubstanceSchedule = ControlledSubstanceSchedule.CII;
    // Even with a (defective) positive counter, the regulatory
    // refusal wins and names 1306.12(a).
    rx.refillsAuthorized = 1;
    rx.refillsRemaining = 1;
    const fake = buildPrismaFake({ prescription: rx });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({
        code: "REFILL_SCHEDULE_II_PROHIBITED",
        metadata: { citation: "21 CFR 1306.12(a)" },
      });
    });
    expect(callsOf(fake.calls, "prescription", "updateMany")).toHaveLength(0);
    expectNoWriteFootprint(fake.calls);
  });

  it("expired yesterday → REFILL_PRESCRIPTION_EXPIRED", async () => {
    const rx = basePrescription();
    rx.expiresAt = new Date("2026-05-22T00:00:00.000Z"); // frozen now is 05-23
    const fake = buildPrismaFake({ prescription: rx });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "REFILL_PRESCRIPTION_EXPIRED" });
    });
    expect(callsOf(fake.calls, "prescription", "updateMany")).toHaveLength(0);
    expectNoWriteFootprint(fake.calls);
  });

  it("CIV written >6 months ago → REFILL_SIX_MONTH_HORIZON_ELAPSED even if expiresAt was widened", async () => {
    const rx = basePrescription();
    rx.controlledSubstanceSchedule = ControlledSubstanceSchedule.CIV;
    rx.originalDateWritten = new Date("2025-10-01T00:00:00.000Z"); // >6mo before frozen now
    rx.expiresAt = new Date("2027-04-01T00:00:00.000Z"); // corrupted: past the horizon
    const fake = buildPrismaFake({ prescription: rx });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({
        code: "REFILL_SIX_MONTH_HORIZON_ELAPSED",
        metadata: { citation: "21 CFR 1306.22(a)" },
      });
    });
    expectNoWriteFootprint(fake.calls);
  });

  it("zero refills left → REFILL_NONE_REMAINING with the counters in metadata", async () => {
    const rx = basePrescription();
    rx.refillsRemaining = 0;
    const fake = buildPrismaFake({ prescription: rx });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({
        code: "REFILL_NONE_REMAINING",
        metadata: { refillsAuthorized: 5, refillsRemaining: 0 },
      });
    });
    expect(callsOf(fake.calls, "prescription", "updateMany")).toHaveLength(0);
    expectNoWriteFootprint(fake.calls);
  });

  it("unshipped order already carries this Rx → REFILL_ORDER_ALREADY_IN_FLIGHT naming the blocker", async () => {
    const existing = "00000000-0000-4000-8000-0000000000cc";
    const fake = buildPrismaFake({ inFlightOrderId: existing });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({
        code: "REFILL_ORDER_ALREADY_IN_FLIGHT",
        metadata: { existingOrderId: existing },
      });
    });

    // The guard excludes terminal states only: SHIPPED and CANCELLED
    // orders do not block a refill.
    const guard = callsOf(fake.calls, "orderLine", "findFirst")[0];
    expect(guard!.args).toMatchObject({
      where: {
        prescriptionId: RX_ID,
        order: { currentStatus: { notIn: ["SHIPPED", "CANCELLED"] } },
      },
    });
    expectNoWriteFootprint(fake.calls);
  });

  it("site missing → ORDER_SITE_NOT_FOUND (shared with CreateOrder)", async () => {
    const fake = buildPrismaFake({ siteFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_SITE_NOT_FOUND" });
    });
    expectNoWriteFootprint(fake.calls);
  });

  it("clinic↔site not linked → ORDER_SITE_NOT_LINKED_TO_CLINIC", async () => {
    const fake = buildPrismaFake({ clinicSiteLinked: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_SITE_NOT_LINKED_TO_CLINIC" });
    });
    expectNoWriteFootprint(fake.calls);
  });

  it("guarded decrement matches 0 rows → REFILL_STATE_CHANGED_CONCURRENTLY, no order created", async () => {
    // Validation read said 3 refills left, but by the time the
    // guarded UPDATE ran another transaction had consumed them (or
    // retired the prescription). Fail closed.
    const fake = buildPrismaFake({ decrementCount: 0 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "REFILL_STATE_CHANGED_CONCURRENTLY" });
    });
    expectNoWriteFootprint(fake.calls);
  });

  it("intake bucket missing → ORDER_INTAKE_BUCKET_NOT_CONFIGURED", async () => {
    const fake = buildPrismaFake({ intakeBucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_INTAKE_BUCKET_NOT_CONFIGURED" });
    });
    expectNoWriteFootprint(fake.calls);
  });

  it("workflow policy missing → WORKFLOW_POLICY_NOT_FOUND (from factory)", async () => {
    const fake = buildPrismaFake({ policyFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
  });
});

// ---------------------------------------------------------------------------
// Tenancy / RBAC
// ---------------------------------------------------------------------------

describe("DispenseRefill — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "prescription", "updateMany")).toHaveLength(0);
    expectNoWriteFootprint(fake.calls);
  });

  it("missing ORDERS_CREATE permission → PERMISSION_DENIED", async () => {
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
        executeCommand(DispenseRefill, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "prescription", "updateMany")).toHaveLength(0);
    expectNoWriteFootprint(fake.calls);
  });
});
