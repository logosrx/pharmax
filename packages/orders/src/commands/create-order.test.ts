// CreateOrder contract tests.
//
// Runs against a hand-rolled Prisma fake (same pattern as
// `create-organization.test.ts`) so the suite is DB-free. The tests
// assert both the positive shape (what was inserted) and the
// negative shape (what was rejected, and that no DB footprint
// remains).
//
// PHI invariant: no test fixture carries patient names or DOBs.
// We exercise the command with synthetic UUIDs only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { IntakeSourceKind, OrderPriority, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { CreateOrder } from "./create-order.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const PATIENT_ID = "00000000-0000-4000-8000-000000000004";
const RX_ID_1 = "00000000-0000-4000-8000-000000000005";
const RX_ID_2 = "00000000-0000-4000-8000-000000000006";
const BUCKET_ID = "00000000-0000-4000-8000-000000000007";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";

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
  clinicId: CLINIC_ID,
  siteId: SITE_ID,
  patientId: PATIENT_ID,
  intakeSourceKind: IntakeSourceKind.API,
  priority: OrderPriority.NORMAL,
  lines: [
    { prescriptionId: RX_ID_1, quantityToFill: 30, daysSupplyToFill: 30 },
    { prescriptionId: RX_ID_2, quantityToFill: 90, daysSupplyToFill: 90 },
  ],
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
  /** If false, `clinic.findFirst` returns null. */
  clinicFound?: boolean;
  /** If false, `pharmacySite.findFirst` returns null. */
  siteFound?: boolean;
  /** If false, `clinicSite.findFirst` returns null. */
  clinicSiteLinked?: boolean;
  /** If false, `patient.findFirst` returns null. */
  patientFound?: boolean;
  /** Override the clinicId the patient row reports. */
  patientClinicId?: string;
  /**
   * Which prescription ids the fake reports as "found". Defaults
   * to [RX_ID_1, RX_ID_2] — the full input set.
   */
  prescriptionIdsFound?: ReadonlyArray<string>;
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
  const orderId = "00000000-0000-4000-8000-0000000000aa";
  let orderLineCounter = 0;
  const nextLineId = () =>
    `00000000-0000-4000-8000-${String(++orderLineCounter).padStart(12, "0")}`;

  const clinicFound = overrides.clinicFound ?? true;
  const siteFound = overrides.siteFound ?? true;
  const clinicSiteLinked = overrides.clinicSiteLinked ?? true;
  const patientFound = overrides.patientFound ?? true;
  const patientClinicId = overrides.patientClinicId ?? CLINIC_ID;
  const prescriptionIdsFound = overrides.prescriptionIdsFound ?? [RX_ID_1, RX_ID_2];
  const intakeBucketFound = overrides.intakeBucketFound ?? true;
  const policyFound = overrides.policyFound ?? true;
  const policyStatus = overrides.policyStatus ?? "ACTIVE";

  const tx = {
    clinic: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "findFirst", args });
        return clinicFound ? { id: CLINIC_ID, status: "ACTIVE" } : null;
      }),
    },
    pharmacySite: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmacySite", op: "findFirst", args });
        return siteFound ? { id: SITE_ID, status: "ACTIVE" } : null;
      }),
    },
    clinicSite: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinicSite", op: "findFirst", args });
        return clinicSiteLinked ? { id: "link-1" } : null;
      }),
    },
    patient: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "patient", op: "findFirst", args });
        return patientFound
          ? { id: PATIENT_ID, clinicId: patientClinicId, status: "ACTIVE" }
          : null;
      }),
    },
    prescription: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "prescription", op: "findMany", args });
        return prescriptionIdsFound.map((id) => ({
          id,
          patientId: PATIENT_ID,
          clinicId: CLINIC_ID,
          status: "ACTIVE",
        }));
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
        return { id: orderId };
      }),
    },
    orderLine: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "create", args });
        return { id: nextLineId() };
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
    clock: clock.createFrozenClock(new Date("2026-05-23T12:00:00.000Z")),
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

describe("CreateOrder — happy path", () => {
  it("returns orderId + orderLineIds and writes order + 2 order lines + order_event + audit + outbox", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(CreateOrder, validInput(), { idempotencyKey: "create-1" })
    );

    expect(out.orderId).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(out.currentStatus).toBe("RECEIVED");
    expect(out.version).toBe(0);
    expect(out.orderLineIds).toHaveLength(2);

    // Scope checks happened in the right order.
    expect(callsOf(fake.calls, "clinic", "findFirst")).toHaveLength(1);
    expect(callsOf(fake.calls, "pharmacySite", "findFirst")).toHaveLength(1);
    expect(callsOf(fake.calls, "clinicSite", "findFirst")).toHaveLength(1);
    expect(callsOf(fake.calls, "patient", "findFirst")).toHaveLength(1);
    expect(callsOf(fake.calls, "prescription", "findMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "bucket", "findFirst")).toHaveLength(1);

    // Policy load: by (organizationId, code, version) — not by id.
    const policyCalls = callsOf(fake.calls, "workflowPolicy", "findUnique");
    expect(policyCalls).toHaveLength(1);
    expect((policyCalls[0]!.args as { where: unknown }).where).toEqual({
      organizationId_code_version: {
        organizationId: ORG_ID,
        code: "order.standard",
        version: 1,
      },
    });

    // Order insert carries the resolved policy + bucket + scope.
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
      intakeSourceKind: "API",
    });

    // One OrderLine row per input line.
    expect(callsOf(fake.calls, "orderLine", "create")).toHaveLength(2);

    const intervalCreate = callsOf(fake.calls, "orderStageInterval", "create")[0];
    expect(intervalCreate).toBeDefined();
    expect((intervalCreate!.args as { data: Record<string, unknown> }).data).toMatchObject({
      organizationId: ORG_ID,
      siteId: SITE_ID,
      kind: "WAIT_BEFORE_TYPING",
    });

    // The factory wrote one order_event row with seq=1.
    const oeCreate = callsOf(fake.calls, "orderEvent", "create");
    expect(oeCreate).toHaveLength(1);
    const oeData = (oeCreate[0]!.args as { data: Record<string, unknown> }).data;
    expect(oeData).toMatchObject({
      organizationId: ORG_ID,
      orderId: "00000000-0000-4000-8000-0000000000aa",
      eventType: "order.received.v1",
      sequenceNumber: 1,
      actorUserId: USER_ID,
    });

    // The bus wrote audit_log + event_outbox + idempotency.
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "idempotencyKey", "create")).toHaveLength(1);
  });

  it("emits order.received.v1 outbox payload with the resolved orderId, scope, line count, and ISO timestamp", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(CreateOrder, validInput(), { idempotencyKey: "create-2" })
    );

    const outboxCall = callsOf(fake.calls, "eventOutbox", "createMany")[0];
    const rows = (outboxCall!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ORG_ID,
      eventType: "order.received.v1",
      aggregateType: "Order",
      aggregateId: "00000000-0000-4000-8000-0000000000aa",
    });
    const payload = rows[0]?.["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({
      orderId: "00000000-0000-4000-8000-0000000000aa",
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      siteId: SITE_ID,
      patientId: PATIENT_ID,
      priority: "NORMAL",
      intakeSourceKind: "API",
      lineCount: 2,
      occurredAt: "2026-05-23T12:00:00.000Z",
    });
  });

  it("audit metadata records scope + policy + line count (NO patient identifiers)", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(CreateOrder, validInput(), { idempotencyKey: "create-3" })
    );

    const auditCall = callsOf(fake.calls, "auditLog", "create")[0];
    const auditData = (auditCall!.args as { data: Record<string, unknown> }).data;
    expect(auditData).toMatchObject({
      action: "order.created",
      resourceType: "Order",
      resourceId: "00000000-0000-4000-8000-0000000000aa",
    });
    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      clinicId: CLINIC_ID,
      siteId: SITE_ID,
      intakeSourceKind: "API",
      priority: "NORMAL",
      lineCount: 2,
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
    });
    // No patient identifiers in metadata.
    expect(metadata["patientId"]).toBeUndefined();
    expect(metadata["firstName"]).toBeUndefined();
    expect(metadata["dateOfBirth"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("CreateOrder — input validation", () => {
  it("rejects bad clinicId UUID", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CreateOrder,
          { ...validInput(), clinicId: "not-a-uuid" },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    // No tx, no scope checks, no order create.
    expect(callsOf(fake.calls, "clinic", "findFirst")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "create")).toHaveLength(0);
  });

  it("rejects empty lines array", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CreateOrder, { ...validInput(), lines: [] }, { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects extra fields (strict schema)", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CreateOrder, { ...validInput(), sneaky: "x" } as never, {
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects negative quantityToFill on a line", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          CreateOrder,
          {
            ...validInput(),
            lines: [{ prescriptionId: RX_ID_1, quantityToFill: -1, daysSupplyToFill: 30 }],
          },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------------
// Scope / state failures
// ---------------------------------------------------------------------------

describe("CreateOrder — scope failures", () => {
  it("clinic missing → ORDER_CLINIC_NOT_FOUND, no order writes", async () => {
    const fake = buildPrismaFake({ clinicFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CreateOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_CLINIC_NOT_FOUND" });
    });
    expect(callsOf(fake.calls, "order", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("site missing → ORDER_SITE_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ siteFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CreateOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_SITE_NOT_FOUND" });
    });
  });

  it("clinic↔site not linked → ORDER_SITE_NOT_LINKED_TO_CLINIC", async () => {
    const fake = buildPrismaFake({ clinicSiteLinked: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CreateOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_SITE_NOT_LINKED_TO_CLINIC" });
    });
  });

  it("patient missing → ORDER_PATIENT_NOT_FOUND", async () => {
    const fake = buildPrismaFake({ patientFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CreateOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_PATIENT_NOT_FOUND" });
    });
  });

  it("patient.clinicId != input.clinicId → ORDER_PATIENT_CLINIC_MISMATCH", async () => {
    const fake = buildPrismaFake({ patientClinicId: "ffffffff-ffff-ffff-ffff-ffffffffffff" });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CreateOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_PATIENT_CLINIC_MISMATCH" });
    });
  });

  it("missing prescription in the batch → ORDER_PRESCRIPTION_MISMATCH with the offending id", async () => {
    const fake = buildPrismaFake({ prescriptionIdsFound: [RX_ID_1] });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CreateOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({
        code: "ORDER_PRESCRIPTION_MISMATCH",
        metadata: { missing: [RX_ID_2] },
      });
    });
  });

  it("intake bucket missing → ORDER_INTAKE_BUCKET_NOT_CONFIGURED", async () => {
    const fake = buildPrismaFake({ intakeBucketFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CreateOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "ORDER_INTAKE_BUCKET_NOT_CONFIGURED" });
    });
  });

  it("workflow policy missing → WORKFLOW_POLICY_NOT_FOUND (from factory)", async () => {
    const fake = buildPrismaFake({ policyFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CreateOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_NOT_FOUND" });
    });
  });

  it("workflow policy not ACTIVE → WORKFLOW_POLICY_INACTIVE (from factory)", async () => {
    const fake = buildPrismaFake({ policyStatus: "DRAFT" });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(CreateOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "WORKFLOW_POLICY_INACTIVE" });
    });
  });
});

// ---------------------------------------------------------------------------
// Tenancy / RBAC
// ---------------------------------------------------------------------------

describe("CreateOrder — tenancy + RBAC", () => {
  it("no tenancy context → TENANCY_NO_CONTEXT, no DB writes", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(CreateOrder, validInput(), { idempotencyKey: "k" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "order", "create")).toHaveLength(0);
  });

  it("missing ORDERS_CREATE permission → PERMISSION_DENIED", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    // Re-wire RBAC with a user who lacks ORDERS_CREATE.
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
        executeCommand(CreateOrder, validInput(), { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsOf(fake.calls, "order", "create")).toHaveLength(0);
  });
});
