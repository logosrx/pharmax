// ChangePassword contract tests (bus-integrated, DB-free).
//
// Pins: current-password verification, anti-reuse rejection, and that a
// successful change revokes other sessions (keeping the current one).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  resetRbacConfigurationForTests,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  buildAuthConfiguration,
  configureAuth,
  resetAuthConfigurationForTests,
} from "../configure.js";
import type { PasswordHasher } from "../password/hasher.js";
import { ChangePassword } from "./change-password.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const CURRENT = "old-secret-phrase-8";

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

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function buildFake(history: ReadonlyArray<{ hashedPassword: string }> = []) {
  const tx = {
    user: {
      findUnique: vi.fn(async () => ({
        hashedPassword: `h:${CURRENT}`,
        email: "operator@example.com",
        displayName: "Operator",
      })),
      update: vi.fn(async () => ({})),
    },
    passwordHistory: {
      findMany: vi.fn(async () => history),
      create: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    // Declare an args param so `mock.calls[n][0]` is typed as the
    // captured argument (not an out-of-range empty-tuple index).
    authSession: { updateMany: vi.fn(async (_args: unknown) => ({ count: 2 })) },
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
  configureRbac({ loader: new InMemoryPermissionLoader([]) });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetAuthConfigurationForTests();
});

describe("ChangePassword", () => {
  it("changes the password and revokes OTHER sessions (keeps current)", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        ChangePassword,
        {
          currentPassword: CURRENT,
          newPassword: "brand-new-secret-9x",
          exceptSessionId: "00000000-0000-4000-8000-0000000000ff",
        },
        { idempotencyKey: "cp-1" }
      )
    );

    expect(out.sessionsRevoked).toBe(2);
    // New hash stored.
    expect(fake.tx.user.update).toHaveBeenCalled();
    // Revoke targets all-but-current.
    const revokeArg = fake.tx.authSession.updateMany.mock.calls[0]![0] as {
      where: { userId: string; id?: { not: string }; revokedAt: null };
      data: { revokedReason: string };
    };
    expect(revokeArg.where.userId).toBe(USER_ID);
    expect(revokeArg.where.id).toEqual({ not: "00000000-0000-4000-8000-0000000000ff" });
    expect(revokeArg.data.revokedReason).toBe("PASSWORD_CHANGED");
  });

  it("rejects a wrong current password and changes nothing", async () => {
    const fake = buildFake();
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          ChangePassword,
          { currentPassword: "WRONG", newPassword: "brand-new-secret-9x" },
          { idempotencyKey: "cp-2" }
        )
      )
    ).rejects.toMatchObject({ code: "CURRENT_PASSWORD_INVALID" });
    expect(fake.tx.authSession.updateMany).not.toHaveBeenCalled();
  });

  it("rejects reuse of the current password", async () => {
    const fake = buildFake();
    configureBus(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          ChangePassword,
          { currentPassword: CURRENT, newPassword: CURRENT },
          { idempotencyKey: "cp-3" }
        )
      )
    ).rejects.toMatchObject({ code: "PASSWORD_REUSED" });
    expect(fake.tx.authSession.updateMany).not.toHaveBeenCalled();
  });
});
