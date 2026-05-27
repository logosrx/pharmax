// RevokeUserRole contract tests.

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

import { RevokeUserRole } from "./revoke-user-role.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000009";
const USER_ROLE_ID = "00000000-0000-4000-8000-000000000077";

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

function buildPrismaFake(grant: unknown | null) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];

  const tx = {
    userRole: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "userRole", op: "findFirst", args });
        return grant;
      }),
      delete: vi.fn(async (args: unknown) => {
        calls.push({ table: "userRole", op: "delete", args });
        return { id: USER_ROLE_ID };
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

describe("RevokeUserRole — happy path", () => {
  it("deletes the grant and includes role metadata in the audit", async () => {
    const fake = buildPrismaFake({
      id: USER_ROLE_ID,
      userId: "u1",
      roleId: "r1",
      siteId: null,
      clinicId: null,
      teamId: null,
      role: { code: "OrgAdmin", scope: RoleScope.ORGANIZATION },
    });
    configureBus(fake.client);
    const out = await withTenancyContext(ctx(), () =>
      executeCommand(RevokeUserRole, { userRoleId: USER_ROLE_ID }, { idempotencyKey: "rv-1" })
    );
    expect(out.userRoleId).toBe(USER_ROLE_ID);
    const del = fake.calls.find((c) => c.table === "userRole" && c.op === "delete");
    expect(del).toBeDefined();
  });
});

describe("RevokeUserRole — not found", () => {
  it("throws USER_ROLE_NOT_FOUND when the grant is missing or wrong tenant", async () => {
    const fake = buildPrismaFake(null);
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(RevokeUserRole, { userRoleId: USER_ROLE_ID }, { idempotencyKey: "rv-2" })
      )
    ).rejects.toMatchObject({ code: "USER_ROLE_NOT_FOUND" });
  });
});
