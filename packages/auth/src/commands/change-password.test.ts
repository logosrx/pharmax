// ChangePassword contract tests (bus-integrated, DB-free).
//
// Pins: current-password verification, anti-reuse rejection, that a
// successful change revokes other sessions (keeping the current one),
// and that the command refuses to run at all unless the caller screened
// the password against the breach corpus first.
//
// ChangePassword has no orchestration wrapper yet (no route calls it),
// so these tests enter the `withScreenedPassword` frame the way a future
// route handler must.

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
import { withScreenedPassword } from "../password/breach-screen.js";
import type { PasswordHasher } from "../password/hasher.js";
import { ChangePassword, type ChangePasswordInput } from "./change-password.js";

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

/** Screen, then dispatch — the sequence a route handler must follow. */
function run(input: ChangePasswordInput, idempotencyKey: string) {
  return withScreenedPassword(input.newPassword, () =>
    withTenancyContext(ctx(), () => executeCommand(ChangePassword, input, { idempotencyKey }))
  );
}

describe("ChangePassword", () => {
  it("changes the password and revokes OTHER sessions (keeps current)", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run(
      {
        currentPassword: CURRENT,
        newPassword: "brand-new-secret-9x",
        exceptSessionId: "00000000-0000-4000-8000-0000000000ff",
      },
      "cp-1"
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
      run({ currentPassword: "WRONG", newPassword: "brand-new-secret-9x" }, "cp-2")
    ).rejects.toMatchObject({ code: "CURRENT_PASSWORD_INVALID" });
    expect(fake.tx.authSession.updateMany).not.toHaveBeenCalled();
  });

  it("rejects reuse of the current password", async () => {
    const fake = buildFake();
    configureBus(fake.client);
    await expect(
      run({ currentPassword: CURRENT, newPassword: CURRENT }, "cp-3")
    ).rejects.toMatchObject({ code: "PASSWORD_REUSED" });
    expect(fake.tx.authSession.updateMany).not.toHaveBeenCalled();
  });
});

describe("ChangePassword — breach screen", () => {
  it("refuses to run when the caller never screened the password", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    // Fails CLOSED. If a missing screen were treated as "not breached",
    // a route that forgot the frame would look like a working password
    // change while silently never consulting the breach corpus.
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          ChangePassword,
          { currentPassword: CURRENT, newPassword: "brand-new-secret-9x" },
          { idempotencyKey: "cp-unscreened" }
        )
      )
    ).rejects.toMatchObject({ code: "PASSWORD_BREACH_SCREEN_MISSING" });
    expect(fake.tx.user.update).not.toHaveBeenCalled();
    expect(fake.tx.authSession.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a screen that judged a DIFFERENT password", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    // A frame is only evidence about the password it screened. Reusing
    // one across two passwords would launder an unscreened credential
    // through an earlier verdict.
    await expect(
      withScreenedPassword("some-other-passphrase-2", () =>
        withTenancyContext(ctx(), () =>
          executeCommand(
            ChangePassword,
            { currentPassword: CURRENT, newPassword: "brand-new-secret-9x" },
            { idempotencyKey: "cp-mismatch" }
          )
        )
      )
    ).rejects.toMatchObject({ code: "PASSWORD_BREACH_SCREEN_MISSING" });
    expect(fake.tx.user.update).not.toHaveBeenCalled();
  });

  it("changes the password when the corpus is down, and records the bypass", async () => {
    const fake = buildFake();
    configureAuth(
      buildAuthConfiguration({
        clock: clock.createFrozenClock(new Date()),
        hasher: fakeHasher,
        password: {
          breachChecker: { isBreached: () => Promise.reject(new Error("corpus unavailable")) },
        },
      })
    );
    configureBus(fake.client);

    await run({ currentPassword: CURRENT, newPassword: "brand-new-secret-9x" }, "cp-open");

    const audits = fake.tx.auditLog.create.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: { metadata: Record<string, unknown> } }]
    >;
    expect(audits[0]![0].data.metadata["breachScreen"]).toBe("bypassed_error");
  });
});
