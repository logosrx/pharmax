// ViewPatient contract tests.
//
// Covers:
//   - Happy path: patient exists + not shredded → success; audit
//     metadata carries surface + orderId + phiDecryptErrors.
//   - Guard: patient does not exist in this tenant →
//     PATIENT_NOT_FOUND (defense-in-depth above the Prisma
//     extension's tenant filter; the InMemoryPermissionLoader has
//     PATIENTS_READ in ORG scope so it isn't permission-blocked).
//   - Shredded patient: STILL audits the view attempt (operator
//     intent is a useful signal; the missing PHI is just metadata
//     on the audit row).
//   - RBAC: actor without patients.read → PERMISSION_DENIED.
//   - Input validation: unknown surface → COMMAND_INPUT_INVALID.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { PatientStatus, RoleScope } from "@pharmax/database";
import { clock, errors, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { ViewPatient } from "./view-patient.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000aa";
const ORDER_ID = "00000000-0000-4000-8000-0000000000bb";

const grantsWithPatientsRead: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PATIENTS_READ]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ACTOR_USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

interface PatientRow {
  id: string;
  status: PatientStatus;
  cryptoShreddedAt: Date | null;
}

function buildPrismaFake(patient: PatientRow | null) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];

  const tx = {
    patient: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "patient", op: "findFirst", args });
        return patient;
      }),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
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

  return { client, calls, tx };
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
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: ACTOR_USER_ID, grants: grantsWithPatientsRead },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("ViewPatient — happy path", () => {
  it("writes audit + outbox; output carries surface + recordedAt", async () => {
    const fake = buildPrismaFake({
      id: PATIENT_ID,
      status: PatientStatus.ACTIVE,
      cryptoShreddedAt: null,
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        ViewPatient,
        {
          patientId: PATIENT_ID,
          surface: "ORDER_DETAIL_PAGE",
          orderId: ORDER_ID,
          phiDecryptErrors: false,
        },
        { idempotencyKey: "view-1" }
      )
    );

    expect(out.patientId).toBe(PATIENT_ID);
    expect(out.surface).toBe("ORDER_DETAIL_PAGE");
    expect(out.recordedAt).toBe("2026-05-26T20:00:00.000Z");
    expect(out.wasShredded).toBe(false);

    // Audit row was written with the right action + metadata.
    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    expect(audit).toBeDefined();
    const auditData = (audit!.args as { data: Record<string, unknown> }).data;
    expect(auditData["action"]).toBe("patient.viewed");
    expect(auditData["resourceType"]).toBe("Patient");
    expect(auditData["resourceId"]).toBe(PATIENT_ID);
    const meta = auditData["metadata"] as Record<string, unknown>;
    expect(meta["surface"]).toBe("ORDER_DETAIL_PAGE");
    expect(meta["orderId"]).toBe(ORDER_ID);
    expect(meta["phiDecryptErrors"]).toBe(false);
    expect(meta["wasShredded"]).toBe(false);

    // Outbox row was written.
    const outbox = fake.calls.find((c) => c.table === "eventOutbox" && c.op === "createMany");
    expect(outbox).toBeDefined();
    const outboxRows = (
      outbox!.args as {
        data: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }
    ).data;
    expect(outboxRows[0]?.eventType).toBe("patient.viewed.v1");
    expect(outboxRows[0]?.payload["surface"]).toBe("ORDER_DETAIL_PAGE");
  });

  it("omits orderId from metadata when caller did not provide one", async () => {
    const fake = buildPrismaFake({
      id: PATIENT_ID,
      status: PatientStatus.ACTIVE,
      cryptoShreddedAt: null,
    });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        ViewPatient,
        {
          patientId: PATIENT_ID,
          surface: "PATIENT_ADMIN_PAGE",
          phiDecryptErrors: false,
        },
        { idempotencyKey: "view-2" }
      )
    );
    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    const meta = (audit!.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(meta["orderId"]).toBeUndefined();
  });
});

describe("ViewPatient — guards", () => {
  it("throws PATIENT_NOT_FOUND when the row is missing or wrong tenant", async () => {
    const fake = buildPrismaFake(null);
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          ViewPatient,
          {
            patientId: PATIENT_ID,
            surface: "ORDER_DETAIL_PAGE",
            phiDecryptErrors: false,
          },
          { idempotencyKey: "view-3" }
        )
      )
    ).rejects.toMatchObject({ code: "PATIENT_NOT_FOUND" });
  });

  it("still audits the view when the patient was crypto-shredded; output flags wasShredded", async () => {
    const fake = buildPrismaFake({
      id: PATIENT_ID,
      status: PatientStatus.INACTIVE,
      cryptoShreddedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        ViewPatient,
        {
          patientId: PATIENT_ID,
          surface: "ORDER_DETAIL_PAGE",
          phiDecryptErrors: false,
        },
        { idempotencyKey: "view-4" }
      )
    );
    expect(out.wasShredded).toBe(true);
    const audit = fake.calls.find((c) => c.table === "auditLog" && c.op === "create");
    const meta = (audit!.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(meta["wasShredded"]).toBe(true);
    expect(meta["cryptoShreddedAt"]).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("ViewPatient — input validation", () => {
  it("rejects unknown surface at the Zod boundary", async () => {
    const fake = buildPrismaFake({
      id: PATIENT_ID,
      status: PatientStatus.ACTIVE,
      cryptoShreddedAt: null,
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          ViewPatient,
          {
            patientId: PATIENT_ID,
            surface: "NOT_A_REAL_SURFACE",
            phiDecryptErrors: false,
          },
          { idempotencyKey: "view-5" }
        )
      )
    ).rejects.toBeInstanceOf(errors.ValidationError);
  });
});

describe("ViewPatient — RBAC", () => {
  it("denies when actor lacks patients.read", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: ACTOR_USER_ID,
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
    const fake = buildPrismaFake({
      id: PATIENT_ID,
      status: PatientStatus.ACTIVE,
      cryptoShreddedAt: null,
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          ViewPatient,
          {
            patientId: PATIENT_ID,
            surface: "ORDER_DETAIL_PAGE",
            phiDecryptErrors: false,
          },
          { idempotencyKey: "view-6" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
