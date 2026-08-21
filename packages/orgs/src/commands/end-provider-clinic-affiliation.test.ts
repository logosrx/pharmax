// EndProviderClinicAffiliation contract tests.
//
// Two invariants carry the weight:
//
//   1. The row is ENDED, never deleted, and it lands with a reason, an
//      actor and a timestamp together. The table's CHECK constraint
//      refuses a half-ended row, so a partial write is not merely
//      untidy — production would reject it.
//   2. Session revocation is filtered to THIS prescriber's sessions for
//      THIS client. A filter on activeClinicId alone would sign every
//      prescriber out of the client because one of them lost access,
//      and that bug would look like a working feature in any test that
//      only counted revocations.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  AuthSessionRevokeReason,
  ClinicProviderAffiliationStatus,
  RoleScope,
} from "@pharmax/database";
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
  EndProviderClinicAffiliation,
  END_AFFILIATION_ALREADY_ENDED,
  END_AFFILIATION_NOT_FOUND,
} from "./end-provider-clinic-affiliation.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const CLINIC_ID = "00000000-0000-4000-8000-0000000000c1";
const PROVIDER_ID = "00000000-0000-4000-8000-0000000000d1";
const AFFILIATION_ID = "00000000-0000-4000-8000-0000000000e1";
const NPI = "1234567893";
const REASON = "Prescriber left the practice";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.CLINICS_AFFILIATE_PROVIDER]),
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
    affiliation?: { status: ClinicProviderAffiliationStatus } | null;
    revokedSessions?: number;
  } = {}
) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];
  const outboxRows: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const affiliation =
    input.affiliation === undefined
      ? { status: ClinicProviderAffiliationStatus.ACTIVE }
      : input.affiliation;

  const tx = {
    clinicProviderAffiliation: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "affiliation", op: "findFirst", args });
        return affiliation === null
          ? null
          : {
              id: AFFILIATION_ID,
              status: affiliation.status,
              clinic: { id: CLINIC_ID, code: "VALLEY-WELLNESS" },
              provider: { id: PROVIDER_ID, npi: NPI },
            };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "affiliation", op: "update", args });
        return { id: AFFILIATION_ID };
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

const INPUT = { clinicId: CLINIC_ID, providerId: PROVIDER_ID, reason: REASON };

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

describe("EndProviderClinicAffiliation — the ended row", () => {
  it("transitions to ENDED with reason, actor and timestamp together", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(EndProviderClinicAffiliation, INPUT, { idempotencyKey: "epa-1" })
    );

    expect(out.affiliationId).toBe(AFFILIATION_ID);

    const call = fake.calls.find((c) => c.table === "affiliation" && c.op === "update");
    const data = (call!.args as { data: Record<string, unknown> }).data;
    expect(data["status"]).toBe(ClinicProviderAffiliationStatus.ENDED);
    expect(data["endedReason"]).toBe(REASON);
    expect(data["endedByUserId"]).toBe(ACTOR_USER_ID);
    expect(data["endedAt"]).toBeInstanceOf(Date);
  });

  it("never deletes the row — an access review reads it later", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(EndProviderClinicAffiliation, INPUT, { idempotencyKey: "epa-2" })
    );

    expect(fake.tx.clinicProviderAffiliation).not.toHaveProperty("delete");
    expect(fake.calls.some((c) => c.op === "delete")).toBe(false);
  });

  it("carries the reason into both the audit row and the outbox event", async () => {
    const fake = buildPrismaFake({ revokedSessions: 1 });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(EndProviderClinicAffiliation, INPUT, { idempotencyKey: "epa-3" })
    );

    const audit = fake.auditRows.at(-1);
    expect(audit?.["action"]).toBe("org.clinic_provider_affiliation.ended");
    const meta = audit?.["metadata"] as Record<string, unknown>;
    expect(meta["reason"]).toBe(REASON);
    expect(meta["npi"]).toBe(NPI);

    const event = fake.outboxRows.find(
      (r) => r["eventType"] === "org.clinic_provider_affiliation.ended.v1"
    );
    const payload = event?.["payload"] as Record<string, unknown>;
    expect(payload["reason"]).toBe(REASON);
    expect(payload["revokedPortalSessionCount"]).toBe(1);
  });
});

describe("EndProviderClinicAffiliation — session revocation", () => {
  it("revokes only THIS prescriber's sessions for THIS client", async () => {
    const fake = buildPrismaFake({ revokedSessions: 2 });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(EndProviderClinicAffiliation, INPUT, { idempotencyKey: "epa-4" })
    );

    expect(out.revokedPortalSessionCount).toBe(2);

    const call = fake.calls.find((c) => c.table === "portalSession" && c.op === "updateMany");
    const args = call!.args as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(args.where["organizationId"]).toBe(ORG_ID);
    expect(args.where["activeClinicId"]).toBe(CLINIC_ID);
    expect(args.where["revokedAt"]).toBeNull();
    // The narrowing that keeps this from signing out every prescriber
    // at the client.
    expect(args.where["portalAccount"]).toEqual({ providerId: PROVIDER_ID });
    expect(args.data["revokedReason"]).toBe(AuthSessionRevokeReason.ADMIN_REVOKED);
  });

  it("issues both writes through the injected transaction handle, not the global client", async () => {
    const fake = buildPrismaFake({ revokedSessions: 1 });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(EndProviderClinicAffiliation, INPUT, { idempotencyKey: "epa-5" })
    );

    // What this proves: neither write escaped to the ambient `prisma`
    // client, which would put it outside the command's transaction
    // entirely. Both landed on the `tx` the bus handed the handler.
    //
    // What it does NOT prove: that the two writes commit or roll back
    // together. This fake's `$transaction` is `fn => fn(tx)`, so every
    // call sees the same handle whether or not a real transaction
    // exists. Genuine atomicity needs the real-Postgres harness (D3 in
    // the go-live program); asserting it here would be theatre.
    expect(fake.tx.clinicProviderAffiliation.update).toHaveBeenCalled();
    expect(fake.tx.portalSession.updateMany).toHaveBeenCalled();
  });
});

describe("EndProviderClinicAffiliation — guards", () => {
  it("refuses when no affiliation exists", async () => {
    const fake = buildPrismaFake({ affiliation: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(EndProviderClinicAffiliation, INPUT, { idempotencyKey: "epa-6" })
      )
    ).rejects.toMatchObject({ code: END_AFFILIATION_NOT_FOUND });
    expect(fake.tx.portalSession.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an already-ended affiliation", async () => {
    const fake = buildPrismaFake({
      affiliation: { status: ClinicProviderAffiliationStatus.ENDED },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(EndProviderClinicAffiliation, INPUT, { idempotencyKey: "epa-7" })
      )
    ).rejects.toMatchObject({ code: END_AFFILIATION_ALREADY_ENDED });
    expect(fake.tx.clinicProviderAffiliation.update).not.toHaveBeenCalled();
    expect(fake.tx.portalSession.updateMany).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          EndProviderClinicAffiliation,
          { ...INPUT, reason: "  " },
          { idempotencyKey: "epa-8" }
        )
      )
    ).rejects.toThrow();
    expect(fake.tx.clinicProviderAffiliation.update).not.toHaveBeenCalled();
  });

  it("scopes the affiliation lookup to the actor's organization", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(EndProviderClinicAffiliation, INPUT, { idempotencyKey: "epa-9" })
    );

    const call = fake.calls.find((c) => c.table === "affiliation" && c.op === "findFirst");
    const where = (call!.args as { where: Record<string, unknown> }).where;
    expect(where["organizationId"]).toBe(ORG_ID);
  });

  it("denies actors without clinics.affiliate_provider", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: ACTOR_USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.PROVIDERS_READ]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(EndProviderClinicAffiliation, INPUT, { idempotencyKey: "epa-10" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.tx.clinicProviderAffiliation.update).not.toHaveBeenCalled();
    expect(fake.tx.portalSession.updateMany).not.toHaveBeenCalled();
  });
});
