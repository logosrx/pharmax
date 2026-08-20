// UpdateClinic contract tests.
//
// The interesting assertions are about what this command REFUSES to
// touch. `code` is immutable because invoices and prescriptions cite it,
// and ARCHIVED clients are retained to explain history rather than to be
// revised. Both are enforced here rather than left to a UI that happens
// not to render the field.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { ClinicStatus, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { UpdateClinic, UPDATE_CLINIC_ARCHIVED, UPDATE_CLINIC_NOT_FOUND } from "./update-clinic.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const CLINIC_ID = "00000000-0000-4000-8000-0000000000c1";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.CLINICS_UPDATE]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ACTOR_USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function buildPrismaFake(input: { clinic?: { status: ClinicStatus } | null } = {}) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];
  const outboxRows: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const clinic = input.clinic === undefined ? { status: ClinicStatus.ACTIVE } : input.clinic;

  const tx = {
    clinic: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "findFirst", args });
        return clinic === null
          ? null
          : {
              id: CLINIC_ID,
              code: "VALLEY-WELLNESS",
              name: "Valley Wellness Clinic",
              status: clinic.status,
            };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "update", args });
        return { id: CLINIC_ID };
      }),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
      update: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        auditRows.push((args as { data: Record<string, unknown> }).data);
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
        const data = (args as { data: Array<Record<string, unknown>> }).data;
        outboxRows.push(...data);
        return { count: data.length };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
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

  return { client, calls, tx, outboxRows, auditRows };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-08-19T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: ACTOR_USER_ID, grants },
    ]),
  });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("UpdateClinic", () => {
  it("renames the client and writes only the name", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateClinic,
        { clinicId: CLINIC_ID, name: "Valley Wellness Group" },
        { idempotencyKey: "uc-1" }
      )
    );

    expect(out.name).toBe("Valley Wellness Group");
    expect(out.code).toBe("VALLEY-WELLNESS");

    const call = fake.calls.find((c) => c.table === "clinic" && c.op === "update");
    const data = (call!.args as { data: Record<string, unknown> }).data;
    expect(data).toEqual({ name: "Valley Wellness Group" });
  });

  it("records the previous name in the audit row", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateClinic,
        { clinicId: CLINIC_ID, name: "Valley Wellness Group" },
        { idempotencyKey: "uc-2" }
      )
    );

    const audit = fake.auditRows.at(-1);
    expect(audit?.["action"]).toBe("org.clinic.updated");
    const meta = audit?.["metadata"] as Record<string, unknown>;
    expect(meta["previousName"]).toBe("Valley Wellness Clinic");
    expect(meta["name"]).toBe("Valley Wellness Group");

    const event = fake.outboxRows.find((r) => r["eventType"] === "org.clinic.updated.v1");
    expect(event?.["aggregateId"]).toBe(CLINIC_ID);
  });

  it("has no way to change the client code — invoices and prescriptions cite it", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateClinic,
          { clinicId: CLINIC_ID, name: "Valley Wellness Group", code: "NEW-CODE" } as never,
          { idempotencyKey: "uc-3" }
        )
      )
    ).rejects.toThrow();
    expect(fake.tx.clinic.update).not.toHaveBeenCalled();
  });

  it("refuses to edit an archived client", async () => {
    const fake = buildPrismaFake({ clinic: { status: ClinicStatus.ARCHIVED } });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateClinic,
          { clinicId: CLINIC_ID, name: "Whatever" },
          { idempotencyKey: "uc-4" }
        )
      )
    ).rejects.toMatchObject({ code: UPDATE_CLINIC_ARCHIVED });
    expect(fake.tx.clinic.update).not.toHaveBeenCalled();
  });

  it("refuses a client outside the actor's organization", async () => {
    const fake = buildPrismaFake({ clinic: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateClinic,
          { clinicId: CLINIC_ID, name: "Whatever" },
          { idempotencyKey: "uc-5" }
        )
      )
    ).rejects.toMatchObject({ code: UPDATE_CLINIC_NOT_FOUND });

    const call = fake.calls.find((c) => c.table === "clinic" && c.op === "findFirst");
    const where = (call!.args as { where: Record<string, unknown> }).where;
    expect(where["organizationId"]).toBe(ORG_ID);
  });

  it("denies actors without clinics.update", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: ACTOR_USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.CLINICS_READ]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateClinic,
          { clinicId: CLINIC_ID, name: "Whatever" },
          { idempotencyKey: "uc-6" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.tx.clinic.update).not.toHaveBeenCalled();
  });
});
