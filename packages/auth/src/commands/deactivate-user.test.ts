// DeactivateUser contract tests — the off-boarding path (replaces the
// Clerk user.deleted webhook). Pins the security-critical property:
// deactivating a user REVOKES their sessions in the same transaction.

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

import {
  buildAuthConfiguration,
  configureAuth,
  resetAuthConfigurationForTests,
} from "../configure.js";
import type { PasswordHasher } from "../password/hasher.js";
import { DeactivateUser } from "./deactivate-user.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-0000000000ad";
const TARGET_ID = "00000000-0000-4000-8000-0000000000c1";

const fakeHasher: PasswordHasher = {
  async hash(p) {
    return `h:${p}`;
  },
  async verify(h, p) {
    return h === `h:${p}`;
  },
  needsRehash() {
    return false;
  },
};

const manageGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.USERS_MANAGE]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: ADMIN_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function buildFake(opts: { target?: { status: UserStatus } | null; revokedCount?: number }) {
  const tx = {
    user: {
      findUnique: vi.fn(async () =>
        opts.target === null
          ? null
          : { id: TARGET_ID, status: opts.target?.status ?? UserStatus.ACTIVE }
      ),
      update: vi.fn(async () => ({})),
    },
    authSession: {
      updateMany: vi.fn(async () => ({ count: opts.revokedCount ?? 3 })),
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
    idempotencyKey: { create: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) },
    $executeRaw: vi.fn(async () => 0),
  };
  const client = {
    commandLog: { create: vi.fn(async () => ({ id: "cl-pre" })), update: vi.fn(async () => ({})) },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { client, tx };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-07-13T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureAuth(
    buildAuthConfiguration({ clock: clock.createFrozenClock(new Date()), hasher: fakeHasher })
  );
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: ADMIN_ID, grants: manageGrants },
    ]),
  });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetAuthConfigurationForTests();
});

describe("DeactivateUser", () => {
  it("terminates the target and revokes all its sessions in-tx", async () => {
    const fake = buildFake({ target: { status: UserStatus.ACTIVE }, revokedCount: 3 });
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        DeactivateUser,
        { targetUserId: TARGET_ID, status: "TERMINATED", reason: "off-boarded" },
        { idempotencyKey: "deact-1" }
      )
    );

    expect(out.status).toBe(UserStatus.TERMINATED);
    expect(out.sessionsRevoked).toBe(3);
    expect(fake.tx.authSession.updateMany).toHaveBeenCalledTimes(1);
    const revokeCalls = fake.tx.authSession.updateMany.mock.calls as unknown as ReadonlyArray<
      readonly [{ where: { userId: string; revokedAt: null }; data: { revokedReason: string } }]
    >;
    const revokeArgs = revokeCalls[0]![0];
    expect(revokeArgs.where.userId).toBe(TARGET_ID);
    expect(revokeArgs.data.revokedReason).toBe("USER_TERMINATED");
  });

  it("refuses self-deactivation", async () => {
    const fake = buildFake({ target: { status: UserStatus.ACTIVE } });
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          DeactivateUser,
          { targetUserId: ADMIN_ID, status: "SUSPENDED" },
          { idempotencyKey: "deact-self" }
        )
      )
    ).rejects.toMatchObject({ code: "CANNOT_DEACTIVATE_SELF" });
    expect(fake.tx.authSession.updateMany).not.toHaveBeenCalled();
  });

  it("denies without users.manage", async () => {
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: ADMIN_ID,
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
    const fake = buildFake({ target: { status: UserStatus.ACTIVE } });
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          DeactivateUser,
          { targetUserId: TARGET_ID, status: "TERMINATED" },
          { idempotencyKey: "deact-2" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
