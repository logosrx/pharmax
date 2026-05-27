// AssignRole contract tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope, UserStatus } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { AssignRole } from "./assign-role.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const TARGET_USER_ID = "00000000-0000-4000-8000-0000000000aa";
const SITE_ID = "00000000-0000-4000-8000-0000000000bb";
const ROLE_ID_ORG = "00000000-0000-4000-8000-0000000000c1";
const ROLE_ID_SITE = "00000000-0000-4000-8000-0000000000c2";

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
  user?: { id: string; status: UserStatus } | null;
  role?: { id: string; scope: RoleScope } | null;
  site?: { id: string } | null;
  createRoleThrows?: Error;
}) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];

  const tx = {
    user: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "user", op: "findFirst", args });
        return input.user ?? { id: TARGET_USER_ID, status: UserStatus.ACTIVE };
      }),
    },
    role: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "role", op: "findFirst", args });
        return input.role ?? null;
      }),
    },
    pharmacySite: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "pharmacySite", op: "findFirst", args });
        return input.site ?? { id: SITE_ID };
      }),
    },
    userRole: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "userRole", op: "create", args });
        if (input.createRoleThrows !== undefined) throw input.createRoleThrows;
        return { id: "ur-1" };
      }),
    },
    commandLog: { create: vi.fn(async () => ({ id: "cl-1" })) },
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
    clock: clock.createFrozenClock(new Date("2026-05-25T20:00:00.000Z")),
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

describe("AssignRole — ORGANIZATION-scoped role", () => {
  it("grants without any scope ids", async () => {
    const fake = buildPrismaFake({
      role: { id: ROLE_ID_ORG, scope: RoleScope.ORGANIZATION },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        AssignRole,
        { userId: TARGET_USER_ID, roleCode: "OrgAdmin" },
        { idempotencyKey: "ar-1" }
      )
    );
    expect(out.roleScope).toBe(RoleScope.ORGANIZATION);
    const create = fake.calls.find((c) => c.table === "userRole" && c.op === "create");
    const data = (create!.args as { data: Record<string, unknown> }).data;
    expect(data["siteId"]).toBeNull();
    expect(data["clinicId"]).toBeNull();
    expect(data["teamId"]).toBeNull();
  });

  it("rejects when scope ids are provided for ORG-scope role", async () => {
    const fake = buildPrismaFake({
      role: { id: ROLE_ID_ORG, scope: RoleScope.ORGANIZATION },
    });
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AssignRole,
          { userId: TARGET_USER_ID, roleCode: "OrgAdmin", siteId: SITE_ID },
          { idempotencyKey: "ar-2" }
        )
      )
    ).rejects.toMatchObject({ code: "ASSIGN_ROLE_SCOPE_NOT_ALLOWED" });
  });
});

describe("AssignRole — SITE-scoped role", () => {
  it("grants with siteId", async () => {
    const fake = buildPrismaFake({
      role: { id: ROLE_ID_SITE, scope: RoleScope.SITE },
    });
    configureBus(fake.client);
    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        AssignRole,
        { userId: TARGET_USER_ID, roleCode: "Pharmacist", siteId: SITE_ID },
        { idempotencyKey: "ar-3" }
      )
    );
    expect(out.roleScope).toBe(RoleScope.SITE);
  });

  it("requires siteId for SITE-scope role", async () => {
    const fake = buildPrismaFake({
      role: { id: ROLE_ID_SITE, scope: RoleScope.SITE },
    });
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AssignRole,
          { userId: TARGET_USER_ID, roleCode: "Pharmacist" },
          { idempotencyKey: "ar-4" }
        )
      )
    ).rejects.toMatchObject({ code: "ASSIGN_ROLE_SCOPE_REQUIRES_SITE" });
  });
});

describe("AssignRole — guards", () => {
  it("throws ASSIGN_ROLE_ROLE_NOT_FOUND for unknown role code", async () => {
    const fake = buildPrismaFake({ role: null });
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AssignRole,
          { userId: TARGET_USER_ID, roleCode: "DoesNotExist" },
          { idempotencyKey: "ar-5" }
        )
      )
    ).rejects.toMatchObject({ code: "ASSIGN_ROLE_ROLE_NOT_FOUND" });
  });

  it("translates P2002 to USER_ROLE_ALREADY_GRANTED", async () => {
    const err = Object.assign(new Error("dup"), {
      code: "P2002",
      clientVersion: "test",
      meta: {},
      name: "PrismaClientKnownRequestError",
    });
    Object.setPrototypeOf(
      err,
      (await import("@pharmax/database")).Prisma.PrismaClientKnownRequestError.prototype
    );
    const fake = buildPrismaFake({
      role: { id: ROLE_ID_ORG, scope: RoleScope.ORGANIZATION },
      createRoleThrows: err,
    });
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AssignRole,
          { userId: TARGET_USER_ID, roleCode: "OrgAdmin" },
          { idempotencyKey: "ar-6" }
        )
      )
    ).rejects.toMatchObject({ code: "USER_ROLE_ALREADY_GRANTED" });
  });
});
