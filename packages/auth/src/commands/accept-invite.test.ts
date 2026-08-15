// AcceptInvite contract tests (bus-integrated, DB-free).
//
// The setup link is pre-auth bearer material, so this covers the same
// token guards as ResetPassword plus the one that is specific to the
// invite flow: the target must still be INVITED. Anything else — an
// operator who already activated, or one who was suspended — is the
// same opaque RESET_TOKEN_INVALID.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { UserStatus } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

import {
  buildAuthConfiguration,
  configureAuth,
  resetAuthConfigurationForTests,
} from "../configure.js";
import type { PasswordHasher } from "../password/hasher.js";
import { hashSessionToken } from "../session/token.js";
import { AcceptInvite } from "./accept-invite.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const TOKEN_ROW_ID = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-07-13T12:00:00.000Z");

// Synthetic invite material — no real operator, no PHI.
const RAW_TOKEN = "synthetic-invite-setup-token";
const INITIAL_PASSWORD = "first-secret-phrase-6";

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

interface SeedToken {
  readonly expiresAt?: Date;
  readonly usedAt?: Date | null;
}

function buildFake(opts: {
  readonly token?: SeedToken | null;
  readonly status?: UserStatus;
  readonly userMissing?: boolean;
}) {
  // Mutable `usedAt` so a consumed invite stays consumed across two
  // attempts (single-use is a property of the sequence).
  const tokenRow =
    opts.token === null
      ? null
      : {
          id: TOKEN_ROW_ID,
          userId: USER_ID,
          organizationId: ORG_ID,
          // Invites carry a 7-day TTL; anything comfortably future works.
          expiresAt: opts.token?.expiresAt ?? new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
          usedAt: opts.token?.usedAt ?? null,
        };

  const tx = {
    passwordResetToken: {
      findUnique: vi.fn(async (args: { where: { tokenHash: string } }) =>
        tokenRow !== null && args.where.tokenHash === hashSessionToken(RAW_TOKEN)
          ? { ...tokenRow }
          : null
      ),
      update: vi.fn(async (args: { where: { id: string }; data: { usedAt: Date } }) => {
        if (tokenRow !== null) tokenRow.usedAt = args.data.usedAt;
        return {};
      }),
    },
    user: {
      findUnique: vi.fn(async () =>
        opts.userMissing === true
          ? null
          : {
              email: "newhire@example.com",
              displayName: "New Hire",
              status: opts.status ?? UserStatus.INVITED,
            }
      ),
      update: vi.fn(async (_args: unknown) => ({})),
    },
    passwordHistory: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async (_args: unknown) => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    authSession: {
      create: vi.fn(async () => ({ id: "session-1" })),
      updateMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cmd-log-1" })),
      update: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: { create: vi.fn(async () => ({ id: "audit-1" })) },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, tx };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(NOW),
    logger: logger.noopLogger,
  });
}

function run(input: { readonly rawToken: string; readonly newPassword: string }) {
  return withSystemContext("test:accept-invite", () => executeSystemCommand(AcceptInvite, input));
}

/** Neither the credential, the status, nor the token moved. */
function expectNoEffect(fake: ReturnType<typeof buildFake>): void {
  expect(fake.tx.user.update).not.toHaveBeenCalled();
  expect(fake.tx.passwordResetToken.update).not.toHaveBeenCalled();
  expect(fake.tx.auditLog.create).not.toHaveBeenCalled();
}

function userUpdateData(fake: ReturnType<typeof buildFake>): ReadonlyArray<{
  hashedPassword?: string;
  status?: UserStatus;
}> {
  const calls = fake.tx.user.update.mock.calls as unknown as ReadonlyArray<
    readonly [{ where: { id: string }; data: { hashedPassword?: string; status?: UserStatus } }]
  >;
  return calls.map((c) => c[0].data);
}

beforeEach(() => {
  configureAuth(
    buildAuthConfiguration({ clock: clock.createFrozenClock(NOW), hasher: fakeHasher })
  );
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetAuthConfigurationForTests();
});

describe("AcceptInvite — happy path", () => {
  it("sets the initial credential, activates the operator, and consumes the token", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    const out = await run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD });

    expect(out.userId).toBe(USER_ID);

    const writes = userUpdateData(fake);
    const stored = writes.find((d) => d.hashedPassword !== undefined)?.hashedPassword;
    expect(stored).toBe(await fakeHasher.hash(INITIAL_PASSWORD));
    expect(stored).not.toBe(INITIAL_PASSWORD);
    expect(writes.some((d) => d.status === UserStatus.ACTIVE)).toBe(true);

    expect(fake.tx.passwordResetToken.update).toHaveBeenCalledWith({
      where: { id: TOKEN_ROW_ID },
      data: { usedAt: NOW },
    });

    // Accepting an invite must not hand out a session: the operator
    // signs in afterwards, and that is the path that enforces the MFA
    // floor for privileged roles.
    expect(fake.tx.authSession.create).not.toHaveBeenCalled();

    const audits = fake.tx.auditLog.create.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: { action: string; resourceId: string } }]
    >;
    expect(audits[0]![0].data.action).toBe("user.invite_accepted");
    expect(audits[0]![0].data.resourceId).toBe(USER_ID);

    const outbox = fake.tx.eventOutbox.createMany.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: ReadonlyArray<{ eventType: string }> }]
    >;
    expect(outbox[0]![0].data[0]!.eventType).toBe("user.invite_accepted.v1");
  });

  it("refuses the same invite link a second time", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD });

    // The user is ACTIVE after the first acceptance in production, so
    // BOTH the `usedAt` clause and the status clause have to hold for
    // the link to stop working. This asserts the token side.
    await expect(
      run({ rawToken: RAW_TOKEN, newPassword: "another-secret-phrase-3" })
    ).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID" });
  });
});

describe("AcceptInvite — account state guard", () => {
  it("rejects a link for an operator who is already ACTIVE", async () => {
    const fake = buildFake({ status: UserStatus.ACTIVE });
    configureBus(fake.client);

    // Without the INVITED check this command becomes an unauthenticated
    // password reset on a live account: anyone holding an old setup link
    // could re-credential it without knowing the current password.
    await expect(run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD })).rejects.toMatchObject(
      { code: "RESET_TOKEN_INVALID" }
    );
    expectNoEffect(fake);
  });

  it("rejects a link for a SUSPENDED operator", async () => {
    const fake = buildFake({ status: UserStatus.SUSPENDED });
    configureBus(fake.client);

    // A suspended operator must not be able to re-credential their way
    // back in, which is exactly what a status-blind flow would allow.
    await expect(run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD })).rejects.toMatchObject(
      { code: "RESET_TOKEN_INVALID" }
    );
    expectNoEffect(fake);
  });

  it("rejects a link for a TERMINATED operator", async () => {
    const fake = buildFake({ status: UserStatus.TERMINATED });
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD })).rejects.toMatchObject(
      { code: "RESET_TOKEN_INVALID" }
    );
    expectNoEffect(fake);
  });
});

describe("AcceptInvite — token guards", () => {
  it("rejects a token that does not exist", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await expect(
      run({ rawToken: "not-a-token-we-ever-minted", newPassword: INITIAL_PASSWORD })
    ).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID" });
    expectNoEffect(fake);
  });

  it("rejects an already-used token", async () => {
    const fake = buildFake({ token: { usedAt: new Date(NOW.getTime() - 60_000) } });
    configureBus(fake.client);

    // Single-use: a setup link recovered from an inbox after the fact
    // must not activate anything.
    await expect(run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD })).rejects.toMatchObject(
      { code: "RESET_TOKEN_INVALID" }
    );
    expectNoEffect(fake);
  });

  it("rejects an expired token", async () => {
    const fake = buildFake({ token: { expiresAt: new Date(NOW.getTime() - 1) } });
    configureBus(fake.client);

    // Invites live 7 days; without this clause a never-accepted invite
    // is a permanent, unauthenticated way into the organization.
    await expect(run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD })).rejects.toMatchObject(
      { code: "RESET_TOKEN_INVALID" }
    );
    expectNoEffect(fake);
  });

  it("rejects a token whose expiry is exactly now", async () => {
    const fake = buildFake({ token: { expiresAt: NOW } });
    configureBus(fake.client);

    // Boundary: the comparison is `expiresAt <= now`, so the exact
    // expiry instant is CLOSED — same convention as ResetPassword.
    await expect(run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD })).rejects.toMatchObject(
      { code: "RESET_TOKEN_INVALID" }
    );
    expectNoEffect(fake);
  });

  it("accepts a token one millisecond before expiry", async () => {
    const fake = buildFake({ token: { expiresAt: new Date(NOW.getTime() + 1) } });
    configureBus(fake.client);

    const out = await run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD });
    expect(out.userId).toBe(USER_ID);
  });

  it("rejects a token whose user no longer exists", async () => {
    const fake = buildFake({ userMissing: true });
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD })).rejects.toMatchObject(
      { code: "RESET_TOKEN_INVALID" }
    );
    expectNoEffect(fake);
  });
});

describe("AcceptInvite — password policy", () => {
  it("leaves the invite usable when the chosen password fails policy", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: "short" })).rejects.toMatchObject({
      code: "PASSWORD_POLICY_VIOLATION",
    });
    // Policy runs before any write, so a rejected first attempt neither
    // activates the operator without a compliant credential nor burns
    // the only setup link they have.
    expectNoEffect(fake);
  });
});
