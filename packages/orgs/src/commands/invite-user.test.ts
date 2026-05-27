// InviteUser contract tests.

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

import { InviteUser } from "./invite-user.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.USERS_MANAGE]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function buildPrismaFake(input: {
  existing?: { id: string; email: string; status: UserStatus } | null;
  createResult?: { id: string; email: string; status: UserStatus };
}) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];

  const tx = {
    user: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "user", op: "findFirst", args });
        return input.existing ?? null;
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "user", op: "create", args });
        return (
          input.createResult ?? {
            id: "new-user-1",
            email: (args as { data: { email: string } }).data.email,
            status: UserStatus.INVITED,
          }
        );
      }),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: "al-1" })),
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
      createMany: vi.fn(async () => ({ count: 1 })),
    },
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
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("InviteUser — happy path", () => {
  it("creates an INVITED Pharmax user row with normalized email", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        InviteUser,
        { email: "Tech@Example.COM", displayName: "Alex Tech" },
        { idempotencyKey: "invite-1" }
      )
    );

    expect(out.userAlreadyExists).toBe(false);
    expect(out.email).toBe("tech@example.com");
    const create = fake.calls.find((c) => c.table === "user" && c.op === "create");
    expect(create).toBeDefined();
    const data = (create!.args as { data: Record<string, unknown> }).data;
    expect(data["email"]).toBe("tech@example.com");
    expect(data["displayName"]).toBe("Alex Tech");
    expect(data["status"]).toBe(UserStatus.INVITED);
  });
});

describe("InviteUser — idempotent re-invite", () => {
  it("returns the existing user without inserting", async () => {
    const fake = buildPrismaFake({
      existing: { id: "exist-1", email: "tech@example.com", status: UserStatus.ACTIVE },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        InviteUser,
        { email: "tech@example.com", displayName: "Alex Tech" },
        { idempotencyKey: "invite-2" }
      )
    );

    expect(out.userAlreadyExists).toBe(true);
    expect(out.userId).toBe("exist-1");
    const created = fake.calls.find((c) => c.table === "user" && c.op === "create");
    expect(created).toBeUndefined();
  });
});

describe("InviteUser — RBAC", () => {
  it("denies without users.manage", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.ORGS_READ]),
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
          InviteUser,
          { email: "tech@example.com", displayName: "Alex" },
          { idempotencyKey: "invite-3" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
