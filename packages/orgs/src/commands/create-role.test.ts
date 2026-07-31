// CreateRole contract tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { Prisma, RoleScope } from "@pharmax/database";
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
  CreateRole,
  CREATE_ROLE_CODE_ALREADY_EXISTS,
  CREATE_ROLE_PERMISSION_NOT_SEEDED,
  CREATE_ROLE_UNKNOWN_PERMISSION,
} from "./create-role.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const ROLE_ID = "00000000-0000-4000-8000-0000000000d1";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ROLES_MANAGE]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ACTOR_USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function buildPrismaFake(input: {
  permissionRows?: ReadonlyArray<{ id: string; code: string }>;
  createRoleThrows?: Error;
}) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];

  const tx = {
    permission: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "permission", op: "findMany", args });
        return input.permissionRows ?? [];
      }),
    },
    role: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "role", op: "create", args });
        if (input.createRoleThrows !== undefined) throw input.createRoleThrows;
        return { id: ROLE_ID };
      }),
    },
    rolePermission: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "rolePermission", op: "createMany", args });
        return { count: (args as { data: unknown[] }).data.length };
      }),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
      update: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
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

  return { client, calls, tx };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-07-24T12:00:00.000Z")),
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

describe("CreateRole — happy path", () => {
  it("creates a non-system role with its permission grants", async () => {
    const fake = buildPrismaFake({
      permissionRows: [
        { id: "p-1", code: PERMISSIONS.TYPING_START },
        { id: "p-2", code: PERMISSIONS.FILL_START },
      ],
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateRole,
        {
          code: "NightShiftLead",
          name: "Night Shift Lead",
          scope: RoleScope.SITE,
          permissions: [PERMISSIONS.TYPING_START, PERMISSIONS.FILL_START],
        },
        { idempotencyKey: "cr-1" }
      )
    );

    expect(out.roleId).toBe(ROLE_ID);
    expect(out.permissionCount).toBe(2);

    const roleCreate = fake.calls.find((c) => c.table === "role" && c.op === "create");
    const data = (roleCreate!.args as { data: Record<string, unknown> }).data;
    expect(data["isSystem"]).toBe(false);
    expect(data["organizationId"]).toBe(ORG_ID);

    const grantsCreate = fake.calls.find(
      (c) => c.table === "rolePermission" && c.op === "createMany"
    );
    const rows = (grantsCreate!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r["roleId"] === ROLE_ID)).toBe(true);
  });

  it("allows an empty permission set (draft role)", async () => {
    const fake = buildPrismaFake({ permissionRows: [] });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateRole,
        { code: "DraftRole", name: "Draft", scope: RoleScope.ORGANIZATION, permissions: [] },
        { idempotencyKey: "cr-2" }
      )
    );
    expect(out.permissionCount).toBe(0);
    expect(fake.tx.rolePermission.createMany).not.toHaveBeenCalled();
  });

  it("dedupes repeated permission codes", async () => {
    const fake = buildPrismaFake({
      permissionRows: [{ id: "p-1", code: PERMISSIONS.TYPING_START }],
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateRole,
        {
          code: "TypistOnly",
          name: "Typist Only",
          scope: RoleScope.ORGANIZATION,
          permissions: [PERMISSIONS.TYPING_START, PERMISSIONS.TYPING_START],
        },
        { idempotencyKey: "cr-3" }
      )
    );
    expect(out.permissionCount).toBe(1);
  });
});

describe("CreateRole — validation and conflicts", () => {
  it("rejects unrecognized permission codes", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateRole,
          {
            code: "BadRole",
            name: "Bad",
            scope: RoleScope.ORGANIZATION,
            permissions: ["orders.invent"],
          },
          { idempotencyKey: "cr-4" }
        )
      )
    ).rejects.toMatchObject({ code: CREATE_ROLE_UNKNOWN_PERMISSION });
    expect(fake.tx.role.create).not.toHaveBeenCalled();
  });

  it("surfaces registry/seed drift as PERMISSION_NOT_SEEDED", async () => {
    // Registry recognizes the code but the fake DB has no row for it.
    const fake = buildPrismaFake({ permissionRows: [] });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateRole,
          {
            code: "DriftRole",
            name: "Drift",
            scope: RoleScope.ORGANIZATION,
            permissions: [PERMISSIONS.TYPING_START],
          },
          { idempotencyKey: "cr-5" }
        )
      )
    ).rejects.toMatchObject({ code: CREATE_ROLE_PERMISSION_NOT_SEEDED });
  });

  it("maps the unique-code violation to CREATE_ROLE_CODE_ALREADY_EXISTS", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    const fake = buildPrismaFake({ permissionRows: [], createRoleThrows: p2002 });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateRole,
          { code: "OrgAdmin", name: "Dupe", scope: RoleScope.ORGANIZATION, permissions: [] },
          { idempotencyKey: "cr-6" }
        )
      )
    ).rejects.toMatchObject({ code: CREATE_ROLE_CODE_ALREADY_EXISTS });
  });

  it("rejects malformed role codes at the schema boundary", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateRole,
          { code: "1-bad code!", name: "Bad", scope: RoleScope.ORGANIZATION, permissions: [] },
          { idempotencyKey: "cr-7" }
        )
      )
    ).rejects.toThrow();
    expect(fake.tx.role.create).not.toHaveBeenCalled();
  });

  it("denies actors without roles.manage", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: ACTOR_USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.USERS_MANAGE]),
            },
          ],
        },
      ]),
    });
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateRole,
          { code: "NoPerm", name: "No Perm", scope: RoleScope.ORGANIZATION, permissions: [] },
          { idempotencyKey: "cr-8" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.tx.role.create).not.toHaveBeenCalled();
  });
});
