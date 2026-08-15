// CreateBucket contract tests.
//
// Runs against a mocked Prisma client so the suite stays DB-free.
// Asserts:
//   1. Happy path — the row is written with `isSystem: false` and the
//      actor's org, never an operator-supplied one.
//   2. Reserved codes are refused (the workflow engine routes by code).
//   3. Reserved kinds are refused (the emergency report selects by kind).
//   4. `(organizationId, code)` collisions surface as a domain conflict,
//      not a raw Prisma P2002.
//   5. Every scope narrower is proven to belong to the actor's org.
//   6. RBAC — `org.manage_buckets` is required.
//   7. Audit + outbox shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { BucketKind, Prisma, RoleScope } from "@pharmax/database";
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
  CreateBucket,
  CREATE_BUCKET_CLINIC_NOT_IN_ORG,
  CREATE_BUCKET_CODE_ALREADY_EXISTS,
  CREATE_BUCKET_CODE_RESERVED,
  CREATE_BUCKET_KIND_RESERVED,
  CREATE_BUCKET_SITE_NOT_IN_ORG,
  CREATE_BUCKET_TEAM_NOT_IN_ORG,
} from "./create-bucket.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const BUCKET_ID = "00000000-0000-4000-8000-0000000000b1";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const CLINIC_ID = "00000000-0000-4000-8000-000000000004";
const TEAM_ID = "00000000-0000-4000-8000-000000000005";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORG_MANAGE_BUCKETS]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ACTOR_USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function buildPrismaFake(input: {
  createThrows?: Error;
  siteFound?: boolean;
  clinicFound?: boolean;
  teamFound?: boolean;
}) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];
  const outboxRows: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];

  const tx = {
    pharmacySite: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmacySite", op: "findFirst", args });
        return (input.siteFound ?? true) ? { id: SITE_ID } : null;
      }),
    },
    clinic: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "findFirst", args });
        return (input.clinicFound ?? true) ? { id: CLINIC_ID } : null;
      }),
    },
    team: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "team", op: "findFirst", args });
        return (input.teamFound ?? true) ? { id: TEAM_ID } : null;
      }),
    },
    bucket: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "create", args });
        if (input.createThrows !== undefined) throw input.createThrows;
        return { id: BUCKET_ID };
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
    clock: clock.createFrozenClock(new Date("2026-08-15T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    code: "PRIOR_AUTH",
    name: "Prior Authorization",
    kind: BucketKind.HOLD,
    sortOrder: 100,
    ...overrides,
  };
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

describe("CreateBucket — happy path", () => {
  it("creates a non-system bucket scoped to the actor's organization", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateBucket, validInput(), { idempotencyKey: "cb-1" })
    );

    expect(out.bucketId).toBe(BUCKET_ID);
    expect(out.code).toBe("PRIOR_AUTH");

    const create = fake.calls.find((c) => c.table === "bucket" && c.op === "create");
    const data = (create!.args as { data: Record<string, unknown> }).data;
    // isSystem is hard-coded, never operator-supplied: a self-declared
    // system bucket would be undeletable and half-uneditable.
    expect(data["isSystem"]).toBe(false);
    expect(data["organizationId"]).toBe(ORG_ID);
    expect(data["kind"]).toBe(BucketKind.HOLD);
    expect(data["siteId"]).toBeNull();
  });

  it("defaults sortOrder to 100 so custom buckets land after the seeded seven", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateBucket,
        { code: "CALLBACK", name: "Clinic Callback", kind: BucketKind.EXCEPTION },
        { idempotencyKey: "cb-2" }
      )
    );

    const create = fake.calls.find((c) => c.table === "bucket" && c.op === "create");
    const data = (create!.args as { data: Record<string, unknown> }).data;
    expect(data["sortOrder"]).toBe(100);
  });

  it("persists validated site / clinic / team scope narrowers", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateBucket,
        validInput({ siteId: SITE_ID, clinicId: CLINIC_ID, teamId: TEAM_ID }),
        { idempotencyKey: "cb-3" }
      )
    );

    const create = fake.calls.find((c) => c.table === "bucket" && c.op === "create");
    const data = (create!.args as { data: Record<string, unknown> }).data;
    expect(data["siteId"]).toBe(SITE_ID);
    expect(data["clinicId"]).toBe(CLINIC_ID);
    expect(data["teamId"]).toBe(TEAM_ID);
  });

  it("writes the audit row and the versioned outbox event", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(CreateBucket, validInput(), { idempotencyKey: "cb-4" })
    );

    const audit = fake.auditRows.at(-1);
    expect(audit?.["action"]).toBe("org.bucket.created");
    expect(audit?.["resourceType"]).toBe("Bucket");
    expect(audit?.["resourceId"]).toBe(BUCKET_ID);

    const event = fake.outboxRows.find((r) => r["eventType"] === "org.bucket.created.v1");
    expect(event).toBeDefined();
    expect(event?.["aggregateType"]).toBe("Bucket");
    expect(event?.["aggregateId"]).toBe(BUCKET_ID);
  });
});

describe("CreateBucket — reserved codes", () => {
  // Every code the workflow engine resolves by value. If a future
  // BUCKET_CODE_FOR_STATUS entry adds one, RESERVED_BUCKET_CODES picks
  // it up automatically and this list should grow with it.
  const reserved = ["INBOX", "TYPING", "PV1", "FILL", "FINAL", "SHIPPING", "EMERGENCY"];

  for (const code of reserved) {
    it(`refuses to mint a custom bucket claiming the reserved code ${code}`, async () => {
      const fake = buildPrismaFake({});
      configureBus(fake.client);

      await expect(
        withTenancyContext(ctx(), () =>
          executeCommand(CreateBucket, validInput({ code }), { idempotencyKey: `cb-res-${code}` })
        )
      ).rejects.toMatchObject({ code: CREATE_BUCKET_CODE_RESERVED });
      expect(fake.tx.bucket.create).not.toHaveBeenCalled();
    });
  }
});

describe("CreateBucket — reserved kinds", () => {
  it("refuses kind EMERGENCY (it would silently join the emergency SLA report)", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateBucket, validInput({ kind: BucketKind.EMERGENCY }), {
          idempotencyKey: "cb-5",
        })
      )
    ).rejects.toMatchObject({ code: CREATE_BUCKET_KIND_RESERVED });
    expect(fake.tx.bucket.create).not.toHaveBeenCalled();
  });

  it("refuses kind WORKFLOW (nothing would ever route into it)", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateBucket, validInput({ kind: BucketKind.WORKFLOW }), {
          idempotencyKey: "cb-6",
        })
      )
    ).rejects.toMatchObject({ code: CREATE_BUCKET_KIND_RESERVED });
  });

  it("accepts CUSTOM, HOLD, and EXCEPTION", async () => {
    for (const kind of [BucketKind.CUSTOM, BucketKind.HOLD, BucketKind.EXCEPTION]) {
      const fake = buildPrismaFake({});
      configureBus(fake.client);
      const out = await withTenancyContext(ctx(), () =>
        executeCommand(CreateBucket, validInput({ code: `Q_${kind}`, kind }), {
          idempotencyKey: `cb-kind-${kind}`,
        })
      );
      expect(out.kind).toBe(kind);
      resetCommandBusConfigurationForTests();
    }
  });
});

describe("CreateBucket — validation and conflicts", () => {
  it("maps the unique-code violation to CREATE_BUCKET_CODE_ALREADY_EXISTS", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    const fake = buildPrismaFake({ createThrows: p2002 });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateBucket, validInput(), { idempotencyKey: "cb-7" })
      )
    ).rejects.toMatchObject({ code: CREATE_BUCKET_CODE_ALREADY_EXISTS });
  });

  it("rejects malformed codes at the schema boundary", async () => {
    for (const code of ["lower_case", "1LEADING_DIGIT", "HAS SPACE", "X", "HAS-DASH"]) {
      const fake = buildPrismaFake({});
      configureBus(fake.client);
      await expect(
        withTenancyContext(ctx(), () =>
          executeCommand(CreateBucket, validInput({ code }), { idempotencyKey: `cb-bad-${code}` })
        )
      ).rejects.toThrow();
      expect(fake.tx.bucket.create).not.toHaveBeenCalled();
      resetCommandBusConfigurationForTests();
    }
  });

  it("rejects an isSystem flag smuggled through the input", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateBucket, validInput({ isSystem: true }) as never, {
          idempotencyKey: "cb-8",
        })
      )
    ).rejects.toThrow();
    expect(fake.tx.bucket.create).not.toHaveBeenCalled();
  });

  it("refuses a site that does not belong to the actor's organization", async () => {
    const fake = buildPrismaFake({ siteFound: false });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateBucket, validInput({ siteId: SITE_ID }), { idempotencyKey: "cb-9" })
      )
    ).rejects.toMatchObject({ code: CREATE_BUCKET_SITE_NOT_IN_ORG });
    expect(fake.tx.bucket.create).not.toHaveBeenCalled();
  });

  it("refuses a clinic that does not belong to the actor's organization", async () => {
    const fake = buildPrismaFake({ clinicFound: false });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateBucket, validInput({ clinicId: CLINIC_ID }), {
          idempotencyKey: "cb-10",
        })
      )
    ).rejects.toMatchObject({ code: CREATE_BUCKET_CLINIC_NOT_IN_ORG });
  });

  it("refuses a team that does not belong to the actor's organization", async () => {
    const fake = buildPrismaFake({ teamFound: false });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateBucket, validInput({ teamId: TEAM_ID }), { idempotencyKey: "cb-11" })
      )
    ).rejects.toMatchObject({ code: CREATE_BUCKET_TEAM_NOT_IN_ORG });
  });

  it("scopes every narrower lookup to the actor's organization", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateBucket,
        validInput({ siteId: SITE_ID, clinicId: CLINIC_ID, teamId: TEAM_ID }),
        { idempotencyKey: "cb-12" }
      )
    );

    for (const table of ["pharmacySite", "clinic", "team"]) {
      const call = fake.calls.find((c) => c.table === table && c.op === "findFirst");
      const where = (call!.args as { where: Record<string, unknown> }).where;
      expect(where["organizationId"]).toBe(ORG_ID);
    }
  });

  it("denies actors without org.manage_buckets", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: ACTOR_USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.ORG_MANAGE_SITES]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateBucket, validInput(), { idempotencyKey: "cb-13" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.tx.bucket.create).not.toHaveBeenCalled();
  });
});
