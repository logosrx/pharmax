// UpdateRolePermissions contract tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope } from "@pharmax/database";
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
  UpdateRolePermissions,
  UPDATE_ROLE_PERMISSIONS_ROLE_IS_SYSTEM,
  UPDATE_ROLE_PERMISSIONS_ROLE_NOT_FOUND,
  UPDATE_ROLE_PERMISSIONS_UNKNOWN_PERMISSION,
} from "./update-role-permissions.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const ROLE_ID = "00000000-0000-4000-8000-0000000000d1";
const HOLDER_A = "00000000-0000-4000-8000-0000000000e1";
const HOLDER_B = "00000000-0000-4000-8000-0000000000e2";

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
  role?: { id: string; code: string; isSystem: boolean } | null;
  permissionRows?: ReadonlyArray<{ id: string; code: string }>;
  currentGrants?: ReadonlyArray<{ permissionId: string; permission: { code: string } }>;
  holders?: ReadonlyArray<{ userId: string }>;
}) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];

  const tx = {
    role: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "role", op: "findFirst", args });
        return input.role === undefined
          ? { id: ROLE_ID, code: "NightShiftLead", isSystem: false }
          : input.role;
      }),
    },
    permission: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "permission", op: "findMany", args });
        return input.permissionRows ?? [];
      }),
    },
    rolePermission: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "rolePermission", op: "findMany", args });
        return input.currentGrants ?? [];
      }),
      deleteMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "rolePermission", op: "deleteMany", args });
        return { count: 1 };
      }),
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "rolePermission", op: "createMany", args });
        return { count: (args as { data: unknown[] }).data.length };
      }),
    },
    userRole: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "userRole", op: "findMany", args });
        return input.holders ?? [];
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

describe("UpdateRolePermissions — diff application", () => {
  it("adds missing grants and removes stale ones", async () => {
    const fake = buildPrismaFake({
      permissionRows: [
        { id: "p-typing", code: PERMISSIONS.TYPING_START },
        { id: "p-fill", code: PERMISSIONS.FILL_START },
      ],
      currentGrants: [
        { permissionId: "p-typing", permission: { code: PERMISSIONS.TYPING_START } },
        { permissionId: "p-pv1", permission: { code: PERMISSIONS.PV1_START } },
      ],
      holders: [{ userId: HOLDER_A }, { userId: HOLDER_B }],
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateRolePermissions,
        { roleId: ROLE_ID, permissions: [PERMISSIONS.TYPING_START, PERMISSIONS.FILL_START] },
        { idempotencyKey: "urp-1" }
      )
    );

    expect(out.addedPermissions).toEqual([PERMISSIONS.FILL_START]);
    expect(out.removedPermissions).toEqual([PERMISSIONS.PV1_START]);
    expect(out.permissionCount).toBe(2);
    expect(out.affectedUserIds).toEqual([HOLDER_A, HOLDER_B]);

    const del = fake.calls.find((c) => c.table === "rolePermission" && c.op === "deleteMany");
    expect(
      (del!.args as { where: { permissionId: { in: string[] } } }).where.permissionId.in
    ).toEqual(["p-pv1"]);

    const add = fake.calls.find((c) => c.table === "rolePermission" && c.op === "createMany");
    expect((add!.args as { data: Array<{ permissionId: string }> }).data).toEqual([
      { roleId: ROLE_ID, permissionId: "p-fill" },
    ]);
  });

  it("no-ops the write when the desired set equals the current set", async () => {
    const fake = buildPrismaFake({
      permissionRows: [{ id: "p-typing", code: PERMISSIONS.TYPING_START }],
      currentGrants: [{ permissionId: "p-typing", permission: { code: PERMISSIONS.TYPING_START } }],
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateRolePermissions,
        { roleId: ROLE_ID, permissions: [PERMISSIONS.TYPING_START] },
        { idempotencyKey: "urp-2" }
      )
    );
    expect(out.addedPermissions).toEqual([]);
    expect(out.removedPermissions).toEqual([]);
    expect(fake.tx.rolePermission.deleteMany).not.toHaveBeenCalled();
    expect(fake.tx.rolePermission.createMany).not.toHaveBeenCalled();
  });

  it("allows stripping a role to an empty set", async () => {
    const fake = buildPrismaFake({
      permissionRows: [],
      currentGrants: [{ permissionId: "p-typing", permission: { code: PERMISSIONS.TYPING_START } }],
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateRolePermissions,
        { roleId: ROLE_ID, permissions: [] },
        { idempotencyKey: "urp-3" }
      )
    );
    expect(out.removedPermissions).toEqual([PERMISSIONS.TYPING_START]);
    expect(out.permissionCount).toBe(0);
  });
});

describe("UpdateRolePermissions — guards", () => {
  it("refuses to edit a system role", async () => {
    const fake = buildPrismaFake({
      role: { id: ROLE_ID, code: "Pharmacist", isSystem: true },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateRolePermissions,
          { roleId: ROLE_ID, permissions: [PERMISSIONS.TYPING_START] },
          { idempotencyKey: "urp-4" }
        )
      )
    ).rejects.toMatchObject({ code: UPDATE_ROLE_PERMISSIONS_ROLE_IS_SYSTEM });
    expect(fake.tx.rolePermission.deleteMany).not.toHaveBeenCalled();
    expect(fake.tx.rolePermission.createMany).not.toHaveBeenCalled();
  });

  it("404s a role outside the organization", async () => {
    const fake = buildPrismaFake({ role: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateRolePermissions,
          { roleId: ROLE_ID, permissions: [] },
          { idempotencyKey: "urp-5" }
        )
      )
    ).rejects.toMatchObject({ code: UPDATE_ROLE_PERMISSIONS_ROLE_NOT_FOUND });
  });

  it("rejects unrecognized permission codes", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          UpdateRolePermissions,
          { roleId: ROLE_ID, permissions: ["totally.made_up"] },
          { idempotencyKey: "urp-6" }
        )
      )
    ).rejects.toMatchObject({ code: UPDATE_ROLE_PERMISSIONS_UNKNOWN_PERMISSION });
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
          UpdateRolePermissions,
          { roleId: ROLE_ID, permissions: [] },
          { idempotencyKey: "urp-7" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
