// SetClinicStatus contract tests.
//
// The two invariants that matter most here are not the status write:
//
//   1. Deactivating a client REVOKES the provider-portal sessions still
//      acting for it, in the same transaction. The session row is the
//      portal's entire authorization story, so a session left open is a
//      live scope into a client the pharmacy has just closed.
//   2. ARCHIVED is reachable only from INACTIVE, only with no orders in
//      flight, and has no way out.
//
// Also asserts a no-op is surfaced rather than silently succeeding, and
// that reactivation revokes nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { AuthSessionRevokeReason, ClinicStatus, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  SetClinicStatus,
  SET_CLINIC_STATUS_ALREADY_SET,
  SET_CLINIC_STATUS_ILLEGAL_TRANSITION,
  SET_CLINIC_STATUS_NOT_FOUND,
  SET_CLINIC_STATUS_ORDERS_IN_FLIGHT,
} from "./set-clinic-status.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const CLINIC_ID = "00000000-0000-4000-8000-0000000000c1";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.CLINICS_SET_STATUS]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ACTOR_USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function buildPrismaFake(
  input: {
    clinic?: { status: ClinicStatus } | null;
    inFlightOrders?: number;
    revokedSessions?: number;
  } = {}
) {
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
          : { id: CLINIC_ID, code: "VALLEY-WELLNESS", status: clinic.status };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "update", args });
        return { id: CLINIC_ID };
      }),
    },
    order: {
      count: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "count", args });
        return input.inFlightOrders ?? 0;
      }),
    },
    portalSession: {
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "portalSession", op: "updateMany", args });
        return { count: input.revokedSessions ?? 0 };
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

function input(status: ClinicStatus, reason = "Contract ended 2026-08-31") {
  return { clinicId: CLINIC_ID, status, reason };
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

describe("SetClinicStatus — session revocation", () => {
  it("revokes every live portal session acting for a deactivated client", async () => {
    const fake = buildPrismaFake({ clinic: { status: ClinicStatus.ACTIVE }, revokedSessions: 3 });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(SetClinicStatus, input(ClinicStatus.INACTIVE), { idempotencyKey: "scs-1" })
    );

    expect(out.revokedPortalSessionCount).toBe(3);

    const call = fake.calls.find((c) => c.table === "portalSession" && c.op === "updateMany");
    const args = call!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(args.where["organizationId"]).toBe(ORG_ID);
    expect(args.where["activeClinicId"]).toBe(CLINIC_ID);
    // Only sessions that are still live.
    expect(args.where["revokedAt"]).toBeNull();
    // ADMIN_REVOKED, not SCOPE_CHANGED: the prescriber did not choose
    // this, an administrator did.
    expect(args.data["revokedReason"]).toBe(AuthSessionRevokeReason.ADMIN_REVOKED);
    expect(args.data["revokedAt"]).toBeInstanceOf(Date);
  });

  it("revokes nothing on reactivation — signing prescribers out of a reopened client inverts the intent", async () => {
    const fake = buildPrismaFake({ clinic: { status: ClinicStatus.INACTIVE } });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(SetClinicStatus, input(ClinicStatus.ACTIVE), { idempotencyKey: "scs-2" })
    );

    expect(out.revokedPortalSessionCount).toBe(0);
    expect(fake.tx.portalSession.updateMany).not.toHaveBeenCalled();
  });

  it("carries the revoked count into the audit row and the outbox event", async () => {
    const fake = buildPrismaFake({ clinic: { status: ClinicStatus.ACTIVE }, revokedSessions: 2 });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(SetClinicStatus, input(ClinicStatus.INACTIVE), { idempotencyKey: "scs-3" })
    );

    const audit = fake.auditRows.at(-1);
    expect(audit?.["action"]).toBe("org.clinic.status_changed");
    const auditMeta = audit?.["metadata"] as Record<string, unknown>;
    expect(auditMeta["revokedPortalSessionCount"]).toBe(2);
    expect(auditMeta["fromStatus"]).toBe(ClinicStatus.ACTIVE);
    expect(auditMeta["toStatus"]).toBe(ClinicStatus.INACTIVE);

    const event = fake.outboxRows.find((r) => r["eventType"] === "org.clinic.status_changed.v1");
    const payload = event?.["payload"] as Record<string, unknown>;
    expect(payload["revokedPortalSessionCount"]).toBe(2);
    expect(payload["reason"]).toBe("Contract ended 2026-08-31");
  });
});

describe("SetClinicStatus — transition table", () => {
  it("refuses ACTIVE -> ARCHIVED; archiving must pass through INACTIVE", async () => {
    const fake = buildPrismaFake({ clinic: { status: ClinicStatus.ACTIVE } });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(SetClinicStatus, input(ClinicStatus.ARCHIVED), { idempotencyKey: "scs-4" })
      )
    ).rejects.toMatchObject({ code: SET_CLINIC_STATUS_ILLEGAL_TRANSITION });
    expect(fake.tx.clinic.update).not.toHaveBeenCalled();
  });

  it("archives from INACTIVE when no order is in flight", async () => {
    const fake = buildPrismaFake({
      clinic: { status: ClinicStatus.INACTIVE },
      inFlightOrders: 0,
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(SetClinicStatus, input(ClinicStatus.ARCHIVED), { idempotencyKey: "scs-5" })
    );

    expect(out.toStatus).toBe(ClinicStatus.ARCHIVED);
  });

  it("refuses to archive a client with orders still in flight", async () => {
    const fake = buildPrismaFake({
      clinic: { status: ClinicStatus.INACTIVE },
      inFlightOrders: 4,
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(SetClinicStatus, input(ClinicStatus.ARCHIVED), { idempotencyKey: "scs-6" })
      )
    ).rejects.toMatchObject({ code: SET_CLINIC_STATUS_ORDERS_IN_FLIGHT });
    expect(fake.tx.clinic.update).not.toHaveBeenCalled();
  });

  it("counts in-flight orders as those not SHIPPED or CANCELLED, scoped to org and client", async () => {
    const fake = buildPrismaFake({ clinic: { status: ClinicStatus.INACTIVE } });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(SetClinicStatus, input(ClinicStatus.ARCHIVED), { idempotencyKey: "scs-7" })
    );

    const call = fake.calls.find((c) => c.table === "order" && c.op === "count");
    const where = (call!.args as { where: Record<string, unknown> }).where;
    expect(where["organizationId"]).toBe(ORG_ID);
    expect(where["clinicId"]).toBe(CLINIC_ID);
    expect(where["currentStatus"]).toEqual({ notIn: ["SHIPPED", "CANCELLED"] });
  });

  for (const target of [ClinicStatus.ACTIVE, ClinicStatus.INACTIVE]) {
    it(`refuses ARCHIVED -> ${target}; archived is terminal`, async () => {
      const fake = buildPrismaFake({ clinic: { status: ClinicStatus.ARCHIVED } });
      configureBus(fake.client);

      await expect(
        withTenancyContext(ctx(), () =>
          executeCommand(SetClinicStatus, input(target), { idempotencyKey: `scs-term-${target}` })
        )
      ).rejects.toMatchObject({ code: SET_CLINIC_STATUS_ILLEGAL_TRANSITION });
      expect(fake.tx.clinic.update).not.toHaveBeenCalled();
    });
  }

  it("surfaces a no-op rather than silently succeeding", async () => {
    const fake = buildPrismaFake({ clinic: { status: ClinicStatus.INACTIVE } });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(SetClinicStatus, input(ClinicStatus.INACTIVE), { idempotencyKey: "scs-8" })
      )
    ).rejects.toMatchObject({ code: SET_CLINIC_STATUS_ALREADY_SET });
    expect(fake.tx.clinic.update).not.toHaveBeenCalled();
  });
});

describe("SetClinicStatus — scope and access", () => {
  it("refuses a client outside the actor's organization", async () => {
    const fake = buildPrismaFake({ clinic: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(SetClinicStatus, input(ClinicStatus.INACTIVE), { idempotencyKey: "scs-9" })
      )
    ).rejects.toMatchObject({ code: SET_CLINIC_STATUS_NOT_FOUND });

    const call = fake.calls.find((c) => c.table === "clinic" && c.op === "findFirst");
    const where = (call!.args as { where: Record<string, unknown> }).where;
    expect(where["organizationId"]).toBe(ORG_ID);
  });

  it("requires a reason", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          SetClinicStatus,
          { clinicId: CLINIC_ID, status: ClinicStatus.INACTIVE, reason: "   " },
          { idempotencyKey: "scs-10" }
        )
      )
    ).rejects.toThrow();
    expect(fake.tx.clinic.update).not.toHaveBeenCalled();
  });

  it("denies actors without clinics.set_status, leaving sessions untouched", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: ACTOR_USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              // Editing a client's name does not imply switching it off.
              permissions: new Set([PERMISSIONS.CLINICS_UPDATE]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(SetClinicStatus, input(ClinicStatus.INACTIVE), { idempotencyKey: "scs-11" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.tx.clinic.update).not.toHaveBeenCalled();
    expect(fake.tx.portalSession.updateMany).not.toHaveBeenCalled();
  });
});
