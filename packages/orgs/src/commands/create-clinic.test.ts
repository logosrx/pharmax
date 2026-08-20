// CreateClinic contract tests.
//
// Runs against a mocked Prisma client so the suite stays DB-free.
// Asserts:
//   1. Happy path — the row carries the ACTOR's org, never an
//      operator-supplied one, and opens ACTIVE.
//   2. The first site in `siteIds` becomes the primary link and the
//      rest do not.
//   3. Every supplied site is proven to belong to the actor's org.
//   4. A repeated site id is refused before any write.
//   5. `(organizationId, code)` collisions surface as a domain conflict
//      rather than a raw Prisma P2002.
//   6. Code shape is enforced at the schema boundary.
//   7. RBAC — `clinics.create` is required, and a denial writes nothing.
//   8. Audit + outbox shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { ClinicStatus, Prisma, RoleScope } from "@pharmax/database";
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
  CreateClinic,
  CREATE_CLINIC_CODE_ALREADY_EXISTS,
  CREATE_CLINIC_DUPLICATE_SITE,
  CREATE_CLINIC_SITE_NOT_IN_ORG,
} from "./create-clinic.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const CLINIC_ID = "00000000-0000-4000-8000-0000000000c1";
const SITE_A = "00000000-0000-4000-8000-00000000005a";
const SITE_B = "00000000-0000-4000-8000-00000000005b";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.CLINICS_CREATE]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ACTOR_USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function buildPrismaFake(input: { createThrows?: Error; sitesInOrg?: ReadonlyArray<string> } = {}) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];
  const outboxRows: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const sitesInOrg = input.sitesInOrg ?? [SITE_A, SITE_B];

  const tx = {
    pharmacySite: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmacySite", op: "findMany", args });
        const requested = (args as { where: { id: { in: ReadonlyArray<string> } } }).where.id.in;
        return requested.filter((id) => sitesInOrg.includes(id)).map((id) => ({ id }));
      }),
    },
    clinic: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "create", args });
        if (input.createThrows !== undefined) throw input.createThrows;
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

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    code: "VALLEY-WELLNESS",
    name: "Valley Wellness Clinic",
    siteIds: [SITE_A],
    ...overrides,
  };
}

function createData(fake: ReturnType<typeof buildPrismaFake>): Record<string, unknown> {
  const call = fake.calls.find((c) => c.table === "clinic" && c.op === "create");
  return (call!.args as { data: Record<string, unknown> }).data;
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

describe("CreateClinic — happy path", () => {
  it("creates the client scoped to the actor's organization, opening ACTIVE", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateClinic, validInput(), { idempotencyKey: "cc-1" })
    );

    expect(out.clinicId).toBe(CLINIC_ID);
    expect(out.code).toBe("VALLEY-WELLNESS");
    expect(out.status).toBe(ClinicStatus.ACTIVE);

    const data = createData(fake);
    expect(data["organizationId"]).toBe(ORG_ID);
    expect(data["status"]).toBe(ClinicStatus.ACTIVE);
  });

  it("makes the first site primary and leaves the rest secondary", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(CreateClinic, validInput({ siteIds: [SITE_A, SITE_B] }), {
        idempotencyKey: "cc-2",
      })
    );

    const data = createData(fake);
    const links = (data["siteLinks"] as { create: Array<Record<string, unknown>> }).create;
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ siteId: SITE_A, isPrimary: true });
    expect(links[1]).toEqual({ siteId: SITE_B, isPrimary: false });
  });

  it("writes the audit row and the versioned outbox event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(CreateClinic, validInput(), { idempotencyKey: "cc-3" })
    );

    const audit = fake.auditRows.at(-1);
    expect(audit?.["action"]).toBe("org.clinic.created");
    expect(audit?.["resourceType"]).toBe("Clinic");
    expect(audit?.["resourceId"]).toBe(CLINIC_ID);

    const event = fake.outboxRows.find((r) => r["eventType"] === "org.clinic.created.v1");
    expect(event).toBeDefined();
    expect(event?.["aggregateType"]).toBe("Clinic");
    expect(event?.["aggregateId"]).toBe(CLINIC_ID);
  });
});

describe("CreateClinic — guards", () => {
  it("scopes the site lookup to the actor's organization", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(CreateClinic, validInput(), { idempotencyKey: "cc-4" })
    );

    const call = fake.calls.find((c) => c.table === "pharmacySite" && c.op === "findMany");
    const where = (call!.args as { where: Record<string, unknown> }).where;
    expect(where["organizationId"]).toBe(ORG_ID);
  });

  it("refuses a site that belongs to another organization, writing nothing", async () => {
    // SITE_B is not in this org's site list, so the lookup returns one
    // row for a two-id request.
    const fake = buildPrismaFake({ sitesInOrg: [SITE_A] });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateClinic, validInput({ siteIds: [SITE_A, SITE_B] }), {
          idempotencyKey: "cc-5",
        })
      )
    ).rejects.toMatchObject({ code: CREATE_CLINIC_SITE_NOT_IN_ORG });
    expect(fake.tx.clinic.create).not.toHaveBeenCalled();
  });

  it("refuses a repeated site id before touching the database", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateClinic, validInput({ siteIds: [SITE_A, SITE_A] }), {
          idempotencyKey: "cc-6",
        })
      )
    ).rejects.toMatchObject({ code: CREATE_CLINIC_DUPLICATE_SITE });
    expect(fake.tx.pharmacySite.findMany).not.toHaveBeenCalled();
    expect(fake.tx.clinic.create).not.toHaveBeenCalled();
  });

  it("requires at least one site — a client no site can fill for is not onboarded", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateClinic, validInput({ siteIds: [] }), { idempotencyKey: "cc-7" })
      )
    ).rejects.toThrow();
    expect(fake.tx.clinic.create).not.toHaveBeenCalled();
  });

  it("maps a code collision to a domain conflict, not a raw P2002", async () => {
    const fake = buildPrismaFake({
      createThrows: new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "7.9.1",
      }),
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateClinic, validInput(), { idempotencyKey: "cc-8" })
      )
    ).rejects.toMatchObject({ code: CREATE_CLINIC_CODE_ALREADY_EXISTS });
  });

  it("rejects malformed codes at the schema boundary", async () => {
    for (const code of ["lower-case", "1LEADING", "HAS SPACE", "X", "HAS.DOT"]) {
      const fake = buildPrismaFake();
      configureBus(fake.client);
      await expect(
        withTenancyContext(ctx(), () =>
          executeCommand(CreateClinic, validInput({ code }), { idempotencyKey: `cc-bad-${code}` })
        )
      ).rejects.toThrow();
      expect(fake.tx.clinic.create).not.toHaveBeenCalled();
      resetCommandBusConfigurationForTests();
    }
  });

  it("rejects a status smuggled through the input", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateClinic, validInput({ status: ClinicStatus.ARCHIVED }) as never, {
          idempotencyKey: "cc-9",
        })
      )
    ).rejects.toThrow();
    expect(fake.tx.clinic.create).not.toHaveBeenCalled();
  });

  it("denies actors without clinics.create", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: ACTOR_USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              // Reading the directory does not imply admitting a new
              // billing counterparty to the organization.
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
        executeCommand(CreateClinic, validInput(), { idempotencyKey: "cc-10" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.tx.clinic.create).not.toHaveBeenCalled();
  });
});
