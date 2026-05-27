// CreateOrganization contract tests.
//
// Runs against a mocked Prisma client so the test suite stays DB-
// free. Asserts:
//   1. Happy path: returns { organizationId, adminUserId, roleCount=6 }.
//   2. Calls organization.create, role.create x6, rolePermission.createMany x6,
//      user.create, userRole.create, workflowPolicy.create — in order.
//   3. Slug-collision (Prisma P2002) → ConflictError(ORG_SLUG_TAKEN).
//   4. Missing system permission row → InternalError(ORG_BOOTSTRAP_MISSING_PERMISSIONS).
//   5. Outbox event shape includes the new org id, slug, and ISO timestamp.
//   6. Input validation (Zod) — bad slug / bad email rejected.
//
// We invoke the command via `executeSystemCommand` (the bus), so
// the test also implicitly verifies the bus integration end-to-end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureCommandBus,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { ALL_PERMISSION_CODES, ROLE_TEMPLATES } from "@pharmax/rbac";
import { withSystemContext } from "@pharmax/tenancy";

import { CreateOrganization } from "./create-organization.js";

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

function buildPrismaFake(opts: {
  /** Map permission code → uuid; defaults to all 19 known permissions. */
  permissionIds?: Map<string, string>;
  /** Set true to make organization.create throw P2002 (slug collision). */
  orgSlugCollision?: boolean;
}): { client: unknown; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const permIds =
    opts.permissionIds ??
    new Map<string, string>(
      ALL_PERMISSION_CODES.map((code, i) => [
        code,
        `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      ])
    );

  let orgCounter = 0;
  let userCounter = 0;
  let roleCounter = 0;
  let policyCounter = 0;
  let siteCounter = 0;
  let bucketCounter = 0;

  const newOrgId = () => `11111111-1111-1111-1111-${String(++orgCounter).padStart(12, "0")}`;
  const newUserId = () => `22222222-2222-2222-2222-${String(++userCounter).padStart(12, "0")}`;
  const newRoleId = () => `33333333-3333-3333-3333-${String(++roleCounter).padStart(12, "0")}`;
  const newPolicyId = () => `44444444-4444-4444-4444-${String(++policyCounter).padStart(12, "0")}`;
  const newSiteId = () => `55555555-5555-5555-5555-${String(++siteCounter).padStart(12, "0")}`;
  const newBucketId = () => `66666666-6666-6666-6666-${String(++bucketCounter).padStart(12, "0")}`;

  // Tracks any sites created in-tx so pharmacySite.findUnique (invoked
  // by provisionDefaultBucketsForSite for cross-tenant verification)
  // can see them. Buckets are similarly tracked so the upsert-by-code
  // loop is a pure no-op when re-run in the same tx.
  const sites = new Map<string, { id: string; organizationId: string }>();
  const buckets = new Map<string, { id: string; siteId: string; code: string }>(); // key: `${orgId}::${code}`

  const tx = {
    organization: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "organization", op: "create", args });
        if (opts.orgSlugCollision === true) {
          // Prisma's constructor signature varies by version; this
          // shape is what runtime code path matches against.
          const e = new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on the fields: (`slug`)",
            { code: "P2002", clientVersion: "5.22.0" }
          );
          throw e;
        }
        return { id: newOrgId(), ...(args as { data: object }).data };
      }),
    },
    permission: {
      findMany: vi.fn(async () => {
        calls.push({ table: "permission", op: "findMany", args: undefined });
        return Array.from(permIds.entries()).map(([code, id]) => ({ id, code }));
      }),
    },
    role: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "role", op: "create", args });
        return { id: newRoleId(), ...(args as { data: object }).data };
      }),
    },
    rolePermission: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "rolePermission", op: "createMany", args });
        return { count: (args as { data: unknown[] }).data.length };
      }),
    },
    user: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "user", op: "create", args });
        return { id: newUserId(), ...(args as { data: object }).data };
      }),
    },
    userRole: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "userRole", op: "create", args });
        return { id: "ur-1", ...(args as { data: object }).data };
      }),
    },
    workflowPolicy: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "create", args });
        return { id: newPolicyId(), ...(args as { data: object }).data };
      }),
    },
    pharmacySite: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmacySite", op: "create", args });
        const data = (args as { data: { organizationId: string } }).data;
        const id = newSiteId();
        sites.set(id, { id, organizationId: data.organizationId });
        return { id, ...data };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmacySite", op: "findUnique", args });
        const id = (args as { where: { id: string } }).where.id;
        const row = sites.get(id);
        if (row === undefined) return null;
        return row;
      }),
    },
    bucket: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "findUnique", args });
        const w = (
          args as { where: { organizationId_code: { organizationId: string; code: string } } }
        ).where.organizationId_code;
        const row = buckets.get(`${w.organizationId}::${w.code}`);
        if (row === undefined) return null;
        return { id: row.id, siteId: row.siteId };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "bucket", op: "create", args });
        const data = (args as { data: { organizationId: string; code: string; siteId: string } })
          .data;
        const id = newBucketId();
        buckets.set(`${data.organizationId}::${data.code}`, {
          id,
          siteId: data.siteId,
          code: data.code,
        });
        return { id };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cmd-log-1" };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        // The audit chain writer reads `id` from the response; tests
        // don't assert on the value, so a stable string suffices.
        return { id: "audit-log-1" };
      }),
    },
    // The audit chain writer reads/writes `audit_chain_state` to
    // anchor each insert to the prior row's entryHash. In tests we
    // simulate a fresh tenant (no head yet); findUnique returns
    // null so the writer treats this as the genesis insert with
    // seq=1 and prevHash=null. The upsert then advances the head.
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "findUnique", args });
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "upsert", args });
        const data = args as {
          where: { organizationId: string };
          create: { latestHash: Buffer; latestSeq: bigint };
        };
        return {
          organizationId: data.where.organizationId,
          latestHash: data.create.latestHash,
          latestSeq: data.create.latestSeq,
        };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    // The command bus issues set_config GUC calls inside the tx
    // (system-context bypass for RLS). Our fake records each call
    // tagged as `$executeRaw / set_config` so tests can assert the
    // RLS plumbing fires.
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        const joined = template.join("?");
        const op = /\bset_config\b/i.test(joined) ? "set_config" : "raw";
        calls.push({ table: "$executeRaw", op, args: { sql: joined, values: [...values] } });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function findOnly(calls: FakeCall[], table: string, op: string): FakeCall {
  const m = calls.filter((c) => c.table === table && c.op === op);
  if (m.length !== 1) {
    throw new Error(`Expected exactly one ${table}.${op} call, got ${m.length}`);
  }
  return m[0] as FakeCall;
}

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

beforeEach(() => {
  const { client } = buildPrismaFake({});
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-21T18:30:00.000Z")),
    logger: logger.noopLogger,
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

describe("CreateOrganization — happy path", () => {
  it("creates org + 6 roles + role grants + admin user + admin grant + workflow policy", async () => {
    const fake = buildPrismaFake({});
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-21T18:30:00.000Z")),
      logger: logger.noopLogger,
    });

    const out = await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(CreateOrganization, {
        slug: "acme",
        name: "Acme Pharmacy",
        initialAdmin: { email: "owner@acme.test", displayName: "Acme Owner" },
      })
    );

    expect(out.organizationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.adminUserId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.roleCount).toBe(ROLE_TEMPLATES.length);
    expect(ROLE_TEMPLATES.length).toBe(7);

    // Organization create.
    const orgCreate = findOnly(fake.calls, "organization", "create");
    expect(orgCreate.args).toMatchObject({ data: { slug: "acme", name: "Acme Pharmacy" } });

    // Permission lookup.
    expect(callsOf(fake.calls, "permission", "findMany")).toHaveLength(1);

    // ROLE_TEMPLATES.length role.create calls (one per template).
    expect(callsOf(fake.calls, "role", "create")).toHaveLength(ROLE_TEMPLATES.length);

    // …and one rolePermission.createMany per role.
    expect(callsOf(fake.calls, "rolePermission", "createMany")).toHaveLength(ROLE_TEMPLATES.length);

    // 1 user.create.
    const userCreate = findOnly(fake.calls, "user", "create");
    expect(userCreate.args).toMatchObject({
      data: { email: "owner@acme.test", displayName: "Acme Owner", status: "INVITED" },
    });

    // 1 userRole.create — admin grant.
    expect(callsOf(fake.calls, "userRole", "create")).toHaveLength(1);

    // 1 workflowPolicy.create.
    expect(callsOf(fake.calls, "workflowPolicy", "create")).toHaveLength(1);

    // Bus wrote command_log (in-tx for system command) + audit + outbox.
    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
  });

  it("emits organization.created.v1 outbox event with the new org id, slug, name, adminUserId, and ISO timestamp", async () => {
    const fake = buildPrismaFake({});
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-21T18:30:00.000Z")),
      logger: logger.noopLogger,
    });

    const out = await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(CreateOrganization, {
        slug: "beta-org",
        name: "Beta Pharmacy",
        initialAdmin: { email: "owner@beta.test", displayName: "Beta Owner" },
      })
    );

    const outboxCall = findOnly(fake.calls, "eventOutbox", "createMany");
    const events = (outboxCall.args as { data: Array<Record<string, unknown>> }).data;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: out.organizationId,
      eventType: "organization.created.v1",
      aggregateType: "Organization",
      aggregateId: out.organizationId,
    });
    const payload = events[0]?.["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({
      organizationId: out.organizationId,
      slug: "beta-org",
      name: "Beta Pharmacy",
      adminUserId: out.adminUserId,
      occurredAt: "2026-05-21T18:30:00.000Z",
    });
  });
});

describe("CreateOrganization — slug collision", () => {
  it("Prisma P2002 → ConflictError(ORG_SLUG_TAKEN)", async () => {
    const fake = buildPrismaFake({ orgSlugCollision: true });
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date()),
      logger: logger.noopLogger,
    });

    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(CreateOrganization, {
          slug: "duplicate",
          name: "Dup Pharmacy",
          initialAdmin: { email: "dup@test.test", displayName: "Dup" },
        })
      ).rejects.toMatchObject({ code: "ORG_SLUG_TAKEN" });
    });

    // No downstream writes after the failed org.create.
    expect(callsOf(fake.calls, "role", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "user", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

describe("CreateOrganization — missing system permissions", () => {
  it("throws ORG_BOOTSTRAP_MISSING_PERMISSIONS when a template references an unseeded permission", async () => {
    // Empty permission registry: every template's permission lookup will miss.
    const fake = buildPrismaFake({ permissionIds: new Map() });
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date()),
      logger: logger.noopLogger,
    });

    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(CreateOrganization, {
          slug: "no-perms",
          name: "Unseeded",
          initialAdmin: { email: "a@b.test", displayName: "A" },
        })
      ).rejects.toMatchObject({ code: "ORG_BOOTSTRAP_MISSING_PERMISSIONS" });
    });
  });
});

describe("CreateOrganization — initialSite path", () => {
  it("creates the PharmacySite and provisions all 7 canonical buckets inline", async () => {
    const fake = buildPrismaFake({});
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-23T20:00:00.000Z")),
      logger: logger.noopLogger,
    });

    const out = await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(CreateOrganization, {
        slug: "with-site",
        name: "WithSite Pharmacy",
        initialAdmin: { email: "owner@withsite.test", displayName: "WithSite Owner" },
        initialSite: { code: "MAIN", name: "Main Pharmacy", timezone: "America/Los_Angeles" },
      })
    );

    // Output carries the site id and bucket map.
    expect(out.initialSiteId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.initialBucketIdsByCode).toBeDefined();
    const bucketMap = out.initialBucketIdsByCode as Readonly<Record<string, string>>;
    for (const code of ["INBOX", "TYPING", "PV1", "FILL", "FINAL", "SHIPPING", "EMERGENCY"]) {
      expect(bucketMap[code]).toMatch(/^[0-9a-f-]{36}$/);
    }

    // 1 site.create + 7 bucket.findUnique + 7 bucket.create.
    expect(callsOf(fake.calls, "pharmacySite", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "bucket", "findUnique")).toHaveLength(7);
    expect(callsOf(fake.calls, "bucket", "create")).toHaveLength(7);

    // PharmacySite is pinned to the new org, with status ACTIVE and tz honored.
    const siteCreate = findOnly(fake.calls, "pharmacySite", "create");
    expect(siteCreate.args).toMatchObject({
      data: {
        organizationId: out.organizationId,
        code: "MAIN",
        name: "Main Pharmacy",
        timezone: "America/Los_Angeles",
        status: "ACTIVE",
      },
    });
  });

  it("defaults timezone to UTC when not provided", async () => {
    const fake = buildPrismaFake({});
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-23T20:00:00.000Z")),
      logger: logger.noopLogger,
    });

    await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(CreateOrganization, {
        slug: "tz-default",
        name: "TZ Default",
        initialAdmin: { email: "x@y.test", displayName: "X" },
        initialSite: { code: "MAIN", name: "Main" },
      })
    );

    const siteCreate = findOnly(fake.calls, "pharmacySite", "create");
    expect(siteCreate.args).toMatchObject({ data: { timezone: "UTC" } });
  });

  it("emits BOTH organization.created.v1 and org.buckets.provisioned.v1 outbox events", async () => {
    const fake = buildPrismaFake({});
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-23T20:00:00.000Z")),
      logger: logger.noopLogger,
    });

    const out = await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(CreateOrganization, {
        slug: "two-events",
        name: "Two Events",
        initialAdmin: { email: "two@events.test", displayName: "Two" },
        initialSite: { code: "MAIN", name: "Main" },
      })
    );

    const outboxCall = findOnly(fake.calls, "eventOutbox", "createMany");
    const events = (outboxCall.args as { data: Array<Record<string, unknown>> }).data;
    expect(events).toHaveLength(2);

    const orgCreated = events.find((e) => e["eventType"] === "organization.created.v1");
    expect(orgCreated).toBeDefined();
    expect(orgCreated).toMatchObject({
      organizationId: out.organizationId,
      aggregateType: "Organization",
      aggregateId: out.organizationId,
    });
    const orgPayload = orgCreated?.["payload"] as Record<string, unknown>;
    expect(orgPayload).toMatchObject({
      slug: "two-events",
      initialSiteId: out.initialSiteId,
    });

    const bucketsProvisioned = events.find((e) => e["eventType"] === "org.buckets.provisioned.v1");
    expect(bucketsProvisioned).toBeDefined();
    expect(bucketsProvisioned).toMatchObject({
      organizationId: out.organizationId,
      aggregateType: "PharmacySite",
      aggregateId: out.initialSiteId,
    });
    const bucketPayload = bucketsProvisioned?.["payload"] as Record<string, unknown>;
    expect(bucketPayload).toMatchObject({
      organizationId: out.organizationId,
      siteId: out.initialSiteId,
      created: 7,
      alreadyPresent: 0,
      occurredAt: "2026-05-23T20:00:00.000Z",
    });
  });

  it("audit metadata carries initialSite snapshot (siteId, siteCode, bucket counts)", async () => {
    const fake = buildPrismaFake({});
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-23T20:00:00.000Z")),
      logger: logger.noopLogger,
    });

    const out = await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(CreateOrganization, {
        slug: "audit-site",
        name: "Audit Site",
        initialAdmin: { email: "audit@site.test", displayName: "Audit" },
        initialSite: { code: "MAIN", name: "Main" },
      })
    );

    const auditCall = findOnly(fake.calls, "auditLog", "create");
    const data = (auditCall.args as { data: { metadata: Record<string, unknown> } }).data;
    const initialSite = data.metadata["initialSite"] as Record<string, unknown>;
    expect(initialSite).toMatchObject({
      siteId: out.initialSiteId,
      siteCode: "MAIN",
      bucketsCreated: 7,
      bucketsAlreadyPresent: 0,
    });
  });

  it("when initialSite is omitted: no site/bucket calls, single outbox event, audit.initialSite=null", async () => {
    const fake = buildPrismaFake({});
    configureCommandBus({
      prisma: fake.client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
      clock: clock.createFrozenClock(new Date("2026-05-23T20:00:00.000Z")),
      logger: logger.noopLogger,
    });

    const out = await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(CreateOrganization, {
        slug: "no-site",
        name: "No Site",
        initialAdmin: { email: "no@site.test", displayName: "No" },
      })
    );

    expect(out.initialSiteId).toBeUndefined();
    expect(out.initialBucketIdsByCode).toBeUndefined();
    expect(callsOf(fake.calls, "pharmacySite", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "bucket", "create")).toHaveLength(0);

    const outboxCall = findOnly(fake.calls, "eventOutbox", "createMany");
    const events = (outboxCall.args as { data: Array<Record<string, unknown>> }).data;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "organization.created.v1" });

    const auditCall = findOnly(fake.calls, "auditLog", "create");
    const data = (auditCall.args as { data: { metadata: Record<string, unknown> } }).data;
    expect(data.metadata["initialSite"]).toBeNull();
  });

  it("rejects malformed initialSite.code (lowercase)", async () => {
    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(CreateOrganization, {
          slug: "bad-site",
          name: "Bad Site",
          initialAdmin: { email: "bad@site.test", displayName: "Bad" },
          initialSite: { code: "lowercase", name: "Lower" },
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

describe("CreateOrganization — input validation", () => {
  it("rejects malformed slug", async () => {
    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(CreateOrganization, {
          slug: "BadSlug!",
          name: "x",
          initialAdmin: { email: "a@b.test", displayName: "A" },
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects malformed admin email", async () => {
    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(CreateOrganization, {
          slug: "ok",
          name: "OK",
          initialAdmin: { email: "not-an-email", displayName: "A" },
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects extra fields (strict schema)", async () => {
    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(CreateOrganization, {
          slug: "ok",
          name: "OK",
          initialAdmin: { email: "a@b.test", displayName: "A" },
          sneaky: true,
        } as never)
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});
