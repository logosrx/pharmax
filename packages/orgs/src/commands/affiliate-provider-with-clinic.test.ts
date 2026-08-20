// AffiliateProviderWithClinic contract tests.
//
// The invariant worth the most here is the UPSERT: re-affiliating a
// prescriber whose access was previously ended must flip the existing
// row back to ACTIVE, not insert a second one. Two rows for one
// relationship would make "is this prescriber authorized" a question
// about which row you happened to read.
//
// The reactivation path must also clear endedAt / endedReason /
// endedByUserId, because the table's CHECK constraint refuses a row
// that is ACTIVE while still carrying an ending. A test that only
// checked `status` would pass while production rejected the write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  ClinicProviderAffiliationStatus,
  ClinicStatus,
  Prisma,
  ProviderStatus,
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
  AffiliateProviderWithClinic,
  AFFILIATE_PROVIDER_ALREADY_AFFILIATED,
  AFFILIATE_PROVIDER_CLINIC_NOT_ACTIVE,
  AFFILIATE_PROVIDER_CLINIC_NOT_FOUND,
  AFFILIATE_PROVIDER_NOT_ACTIVE,
  AFFILIATE_PROVIDER_NOT_FOUND,
} from "./affiliate-provider-with-clinic.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const CLINIC_ID = "00000000-0000-4000-8000-0000000000c1";
const PROVIDER_ID = "00000000-0000-4000-8000-0000000000d1";
const AFFILIATION_ID = "00000000-0000-4000-8000-0000000000e1";
const NPI = "1234567893";

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
    clinic?: { status: ClinicStatus } | null;
    provider?: { status: ProviderStatus } | null;
    existing?: { status: ClinicProviderAffiliationStatus } | null;
    createThrows?: Error;
  } = {}
) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];
  const outboxRows: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const clinic = input.clinic === undefined ? { status: ClinicStatus.ACTIVE } : input.clinic;
  const provider =
    input.provider === undefined ? { status: ProviderStatus.ACTIVE } : input.provider;
  const existing = input.existing ?? null;

  const tx = {
    clinic: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "findFirst", args });
        return clinic === null
          ? null
          : { id: CLINIC_ID, code: "VALLEY-WELLNESS", status: clinic.status };
      }),
    },
    provider: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "provider", op: "findFirst", args });
        return provider === null ? null : { id: PROVIDER_ID, npi: NPI, status: provider.status };
      }),
    },
    clinicProviderAffiliation: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "affiliation", op: "findFirst", args });
        return existing === null ? null : { id: AFFILIATION_ID, status: existing.status };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "affiliation", op: "create", args });
        if (input.createThrows !== undefined) throw input.createThrows;
        return { id: AFFILIATION_ID };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "affiliation", op: "update", args });
        return { id: AFFILIATION_ID };
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

const INPUT = { clinicId: CLINIC_ID, providerId: PROVIDER_ID };

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

describe("AffiliateProviderWithClinic — first affiliation", () => {
  it("creates the roster row scoped to the actor's organization", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-1" })
    );

    expect(out.affiliationId).toBe(AFFILIATION_ID);
    expect(out.reactivated).toBe(false);

    const call = fake.calls.find((c) => c.table === "affiliation" && c.op === "create");
    const data = (call!.args as { data: Record<string, unknown> }).data;
    expect(data["organizationId"]).toBe(ORG_ID);
    expect(data["clinicId"]).toBe(CLINIC_ID);
    expect(data["providerId"]).toBe(PROVIDER_ID);
    expect(data["status"]).toBe(ClinicProviderAffiliationStatus.ACTIVE);
    expect(data["createdByUserId"]).toBe(ACTOR_USER_ID);
  });

  it("writes the audit row and the versioned outbox event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-2" })
    );

    const audit = fake.auditRows.at(-1);
    expect(audit?.["action"]).toBe("org.clinic_provider_affiliation.created");
    expect(audit?.["resourceType"]).toBe("ClinicProviderAffiliation");

    const event = fake.outboxRows.find(
      (r) => r["eventType"] === "org.clinic_provider_affiliation.created.v1"
    );
    const payload = event?.["payload"] as Record<string, unknown>;
    expect(payload["npi"]).toBe(NPI);
    expect(payload["reactivated"]).toBe(false);
  });
});

describe("AffiliateProviderWithClinic — reactivation", () => {
  it("flips an ENDED row back to ACTIVE instead of inserting a second row", async () => {
    const fake = buildPrismaFake({
      existing: { status: ClinicProviderAffiliationStatus.ENDED },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-3" })
    );

    expect(out.reactivated).toBe(true);
    expect(fake.tx.clinicProviderAffiliation.create).not.toHaveBeenCalled();
    expect(fake.tx.clinicProviderAffiliation.update).toHaveBeenCalled();
  });

  it("clears the ending, which the table's CHECK constraint requires", async () => {
    const fake = buildPrismaFake({
      existing: { status: ClinicProviderAffiliationStatus.ENDED },
    });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-4" })
    );

    const call = fake.calls.find((c) => c.table === "affiliation" && c.op === "update");
    const data = (call!.args as { data: Record<string, unknown> }).data;
    expect(data["status"]).toBe(ClinicProviderAffiliationStatus.ACTIVE);
    expect(data["endedAt"]).toBeNull();
    expect(data["endedReason"]).toBeNull();
    expect(data["endedByUserId"]).toBeNull();
  });

  it("reports reactivation in the outbox payload so an access review can tell it apart", async () => {
    const fake = buildPrismaFake({
      existing: { status: ClinicProviderAffiliationStatus.ENDED },
    });
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-5" })
    );

    const event = fake.outboxRows.find(
      (r) => r["eventType"] === "org.clinic_provider_affiliation.created.v1"
    );
    const payload = event?.["payload"] as Record<string, unknown>;
    expect(payload["reactivated"]).toBe(true);
  });
});

describe("AffiliateProviderWithClinic — guards", () => {
  it("refuses when the affiliation is already ACTIVE", async () => {
    const fake = buildPrismaFake({
      existing: { status: ClinicProviderAffiliationStatus.ACTIVE },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-6" })
      )
    ).rejects.toMatchObject({ code: AFFILIATE_PROVIDER_ALREADY_AFFILIATED });
    expect(fake.tx.clinicProviderAffiliation.create).not.toHaveBeenCalled();
    expect(fake.tx.clinicProviderAffiliation.update).not.toHaveBeenCalled();
  });

  it("maps a concurrent insert (P2002) to the same conflict", async () => {
    const fake = buildPrismaFake({
      createThrows: new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "7.9.1",
      }),
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-7" })
      )
    ).rejects.toMatchObject({ code: AFFILIATE_PROVIDER_ALREADY_AFFILIATED });
  });

  it("refuses a client outside the actor's organization", async () => {
    const fake = buildPrismaFake({ clinic: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-8" })
      )
    ).rejects.toMatchObject({ code: AFFILIATE_PROVIDER_CLINIC_NOT_FOUND });
  });

  it("refuses a deactivated client — authority to write for a client that cannot receive orders", async () => {
    const fake = buildPrismaFake({ clinic: { status: ClinicStatus.INACTIVE } });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-9" })
      )
    ).rejects.toMatchObject({ code: AFFILIATE_PROVIDER_CLINIC_NOT_ACTIVE });
    expect(fake.tx.clinicProviderAffiliation.create).not.toHaveBeenCalled();
  });

  it("refuses a prescriber outside the actor's organization", async () => {
    const fake = buildPrismaFake({ provider: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-10" })
      )
    ).rejects.toMatchObject({ code: AFFILIATE_PROVIDER_NOT_FOUND });
  });

  it("refuses an inactive prescriber", async () => {
    const fake = buildPrismaFake({ provider: { status: ProviderStatus.INACTIVE } });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-11" })
      )
    ).rejects.toMatchObject({ code: AFFILIATE_PROVIDER_NOT_ACTIVE });
    expect(fake.tx.clinicProviderAffiliation.create).not.toHaveBeenCalled();
  });

  it("scopes every lookup to the actor's organization", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-12" })
    );

    for (const table of ["clinic", "provider", "affiliation"]) {
      const call = fake.calls.find((c) => c.table === table && c.op === "findFirst");
      const where = (call!.args as { where: Record<string, unknown> }).where;
      expect(where["organizationId"]).toBe(ORG_ID);
    }
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
              // Reading the provider directory is not authority to
              // decide which clients a prescriber may write for.
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
        executeCommand(AffiliateProviderWithClinic, INPUT, { idempotencyKey: "apc-13" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.tx.clinicProviderAffiliation.create).not.toHaveBeenCalled();
  });
});
