// AcceptInvite contract tests (bus-integrated, DB-free).
//
// Runs the real `acceptInvite` orchestration, pre-transaction breach
// screen included. The setup link is pre-auth bearer material, so this
// covers the same token guards as ResetPassword plus the one that is
// specific to the invite flow: the target must still be INVITED.
// Anything else — an operator who already activated, one who was
// suspended, or a token filed under an organization the user does not
// belong to — is the same opaque RESET_TOKEN_INVALID.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCommandBus, resetCommandBusConfigurationForTests } from "@pharmax/command-bus";
import { UserStatus } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";

import {
  buildAuthConfiguration,
  configureAuth,
  resetAuthConfigurationForTests,
} from "../configure.js";
import { acceptInvite } from "../invite.js";
import type { PasswordHasher } from "../password/hasher.js";
import { hashSessionToken } from "../session/token.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
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
  /**
   * Organization stamped on the token row. Defaults to the one the
   * seeded user actually belongs to; set it to another org to model a
   * historical row whose (user, organization) pair is mismatched.
   */
  readonly organizationId?: string;
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
          organizationId: opts.token?.organizationId ?? ORG_ID,
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
      // The fake database holds ONE user row, and it lives in ORG_ID.
      // It answers whatever `where` it is handed the way Postgres would:
      // every clause present must match, and a clause that is ABSENT
      // constrains nothing. So a command that filters on the wrong
      // organization gets a real miss, and one that forgot to filter at
      // all gets a HIT — which is what makes the tenancy tests below
      // fail for the right reason instead of looking like a missing user.
      findFirst: vi.fn(async (args: { where: { id: string; organizationId?: string } }) =>
        opts.userMissing === true ||
        args.where.id !== USER_ID ||
        (args.where.organizationId !== undefined && args.where.organizationId !== ORG_ID)
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

// The production entry point, so the pre-transaction breach screen the
// command requires is part of what these tests exercise.
function run(input: { readonly rawToken: string; readonly newPassword: string }) {
  return acceptInvite(input);
}

/**
 * Neither the credential, the status, nor the token moved, and no
 * tenant-scoped record of the attempt was written. `user.update` covers
 * both writes the success path makes — the password hash and the
 * INVITED → ACTIVE flip.
 */
function expectNoEffect(fake: ReturnType<typeof buildFake>): void {
  expect(fake.tx.user.update).not.toHaveBeenCalled();
  expect(fake.tx.passwordHistory.create).not.toHaveBeenCalled();
  expect(fake.tx.passwordResetToken.update).not.toHaveBeenCalled();
  expect(fake.tx.auditLog.create).not.toHaveBeenCalled();
  expect(fake.tx.eventOutbox.createMany).not.toHaveBeenCalled();
}

/**
 * `code|message` of the refusal, so two failure paths can be compared
 * for indistinguishability rather than merely both being errors.
 */
async function refusalFingerprint(rawToken: string): Promise<string> {
  try {
    await run({ rawToken, newPassword: INITIAL_PASSWORD });
  } catch (cause) {
    const err = cause as { code: string; message: string };
    return `${err.code}|${err.message}`;
  }
  return "<did not reject>";
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

// The token row is where this command learns which organization to write
// under: `targetOrganizationId`, the audit entry, and the
// `user.invite_accepted.v1` payload all come from it. So a row whose
// `organizationId` does not match its user's would file one tenant's
// activation in another tenant's audit trail and event stream — the two
// artifacts that are supposed to be tenant-scoped truth, and the kind of
// cross-tenant write the repo treats as a critical incident.
//
// IssueInvite now proves that pairing before it mints, so this is
// defence in depth rather than a live exploit: `password_reset_token`
// long predates that check, so a historical row could already carry a
// mismatched pair, and a future writer to the table would not
// necessarily repeat the membership check.
describe("AcceptInvite — tenancy", () => {
  it("refuses a token whose organization is not the user's", async () => {
    // The user row lives in ORG_ID; the token claims OTHER_ORG_ID.
    const fake = buildFake({ token: { organizationId: OTHER_ORG_ID } });
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD })).rejects.toMatchObject(
      {
        code: "RESET_TOKEN_INVALID",
      }
    );
  });

  it("writes nothing at all when it refuses a mismatched token", async () => {
    const fake = buildFake({ token: { organizationId: OTHER_ORG_ID } });
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD })).rejects.toThrow();

    // No credential, no activation, no consumed link, no audit row and
    // no event — and because a system command resolves its target org
    // inside the handler, no command_log row under OTHER_ORG_ID either.
    // A refusal that still filed bookkeeping under the token's claimed
    // organization would itself be the cross-tenant write.
    expectNoEffect(fake);
    expect(fake.tx.commandLog.create).not.toHaveBeenCalled();
  });

  it("looks the user up with the organization filter, not by id alone", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD });

    // Pins the mechanism, not just the outcome: the guard is one
    // org-scoped read, so a foreign row is never loaded at all rather
    // than fetched by id and compared afterwards.
    expect(fake.tx.user.findFirst).toHaveBeenCalledWith({
      where: { id: USER_ID, organizationId: ORG_ID },
      select: { email: true, displayName: true, status: true },
    });
  });

  it("uses the SAME opaque code and message for every refusal, tenancy included", async () => {
    // A caller here is anonymous — it holds an emailed link and nothing
    // else. If the organization mismatch had its own code, that caller
    // would learn that the token names a real user in a real (other)
    // organization, which is exactly the cross-tenant existence oracle
    // the shared refusal exists to deny.
    const fingerprints: string[] = [];
    const cases = [
      buildFake({ token: { organizationId: OTHER_ORG_ID } }),
      buildFake({ status: UserStatus.ACTIVE }),
      buildFake({ status: UserStatus.SUSPENDED }),
      buildFake({ status: UserStatus.TERMINATED }),
      buildFake({ userMissing: true }),
      buildFake({ token: { usedAt: new Date(NOW.getTime() - 60_000) } }),
      buildFake({ token: { expiresAt: new Date(NOW.getTime() - 1) } }),
    ];
    for (const fake of cases) {
      configureBus(fake.client);
      fingerprints.push(await refusalFingerprint(RAW_TOKEN));
      resetCommandBusConfigurationForTests();
    }

    configureBus(buildFake({}).client);
    fingerprints.push(await refusalFingerprint("never-minted"));

    // Compared against the literal rather than merely "all equal", so
    // this cannot pass by every case failing to reject at all.
    expect([...new Set(fingerprints)]).toEqual([
      "RESET_TOKEN_INVALID|This password reset link is invalid or has expired.",
    ]);
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

  it("rejects a breached initial password", async () => {
    const fake = buildFake({});
    configureAuth(
      buildAuthConfiguration({
        clock: clock.createFrozenClock(NOW),
        hasher: fakeHasher,
        password: { breachChecker: { isBreached: async () => true } },
      })
    );
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD })).rejects.toMatchObject(
      { code: "PASSWORD_POLICY_VIOLATION" }
    );
    expectNoEffect(fake);
  });

  it("activates the operator when the breach corpus is down, and records the bypass", async () => {
    const fake = buildFake({});
    configureAuth(
      buildAuthConfiguration({
        clock: clock.createFrozenClock(NOW),
        hasher: fakeHasher,
        password: {
          breachChecker: { isBreached: () => Promise.reject(new Error("corpus unavailable")) },
        },
      })
    );
    configureBus(fake.client);

    // Fail open: a new hire must not be locked out of onboarding by a
    // third party's outage. The audit row is what keeps that visible.
    const out = await run({ rawToken: RAW_TOKEN, newPassword: INITIAL_PASSWORD });
    expect(out.userId).toBe(USER_ID);

    const audits = fake.tx.auditLog.create.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: { metadata: Record<string, unknown> } }]
    >;
    expect(audits[0]![0].data.metadata["breachScreen"]).toBe("bypassed_error");
  });
});
