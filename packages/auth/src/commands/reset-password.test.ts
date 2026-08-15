// ResetPassword contract tests (bus-integrated, DB-free).
//
// Runs the real `resetPassword` orchestration — pre-transaction breach
// screen included — against a mocked Prisma client + a fast fake
// hasher. The token IS the authorization here, so the guards get the
// attention: unknown / consumed / expired tokens and any non-ACTIVE
// user all surface as one opaque RESET_TOKEN_INVALID and write nothing,
// a redeemed token cannot be redeemed twice, and a success stores a
// HASH, stamps `usedAt`, and kills every live session.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCommandBus, resetCommandBusConfigurationForTests } from "@pharmax/command-bus";
import { UserStatus } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";

import {
  buildAuthConfiguration,
  configureAuth,
  resetAuthConfigurationForTests,
} from "../configure.js";
import type { PasswordHasher } from "../password/hasher.js";
import type { BreachChecker } from "../password/policy.js";
import { resetPassword } from "../reset-password.js";
import { hashSessionToken } from "../session/token.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const TOKEN_ROW_ID = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-07-13T12:00:00.000Z");

// Synthetic link material and operator credentials — no real person.
const RAW_TOKEN = "synthetic-reset-link-token";
const OLD_PASSWORD = "previous-secret-77";
const NEW_PASSWORD = "fresh-secret-phrase-9";

// Deterministic fake: a stored hash of "h:<plaintext>" verifies that
// plaintext (Argon2id itself is covered in argon2-hasher.test.ts).
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
  readonly userMissing?: boolean;
  readonly status?: UserStatus;
  readonly revokedCount?: number;
}) {
  // Mutable on purpose: `usedAt` has to survive between two attempts
  // so single-use can be exercised as a sequence, not as one call.
  const tokenRow =
    opts.token === null
      ? null
      : {
          id: TOKEN_ROW_ID,
          userId: USER_ID,
          organizationId: ORG_ID,
          expiresAt: opts.token?.expiresAt ?? new Date(NOW.getTime() + 30 * 60 * 1000),
          usedAt: opts.token?.usedAt ?? null,
        };

  const tx = {
    passwordResetToken: {
      // Answers only to the DIGEST of the raw token, so a test that
      // passes any other string takes the real unknown-token path.
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
              email: "operator@example.com",
              displayName: "Operator",
              hashedPassword: `h:${OLD_PASSWORD}`,
              status: opts.status ?? UserStatus.ACTIVE,
            }
      ),
      update: vi.fn(async (_args: unknown) => ({})),
    },
    passwordHistory: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async (_args: unknown) => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    // Declare an args param so `mock.calls[n][0]` is typed as the
    // captured argument (not an out-of-range empty-tuple index).
    authSession: {
      updateMany: vi.fn(async (_args: unknown) => ({ count: opts.revokedCount ?? 2 })),
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

  // Whether a database transaction is currently open. Lets a test prove
  // where in the sequence the breach check happens, rather than trusting
  // the call graph to stay the way it is today.
  const state = { txOpen: false };

  const client = {
    commandLog: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      state.txOpen = true;
      try {
        return await fn(tx);
      } finally {
        state.txOpen = false;
      }
    }),
  };

  return { client, tx, state };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(NOW),
    logger: logger.noopLogger,
  });
}

// The production entry point: it screens the password against the
// breach corpus and THEN dispatches the command, which is the ordering
// the whole flow depends on.
function run(input: { readonly rawToken: string; readonly newPassword: string }) {
  return resetPassword(input);
}

/**
 * `code|message` of the refusal, so two failure paths can be compared
 * for indistinguishability rather than merely both being errors.
 */
async function refusalFingerprint(input: { readonly rawToken: string }): Promise<string> {
  try {
    await run({ rawToken: input.rawToken, newPassword: NEW_PASSWORD });
  } catch (cause) {
    const err = cause as { code: string; message: string };
    return `${err.code}|${err.message}`;
  }
  return "<did not reject>";
}

/** Audit metadata the bus wrote for the (single) audited command. */
function auditMetadata(fake: ReturnType<typeof buildFake>): Record<string, unknown> {
  const calls = fake.tx.auditLog.create.mock.calls as unknown as ReadonlyArray<
    readonly [{ data: { metadata: Record<string, unknown> } }]
  >;
  return calls[0]![0].data.metadata;
}

/** Nothing about the account changed and no audit trail was written. */
function expectNoEffect(fake: ReturnType<typeof buildFake>): void {
  expect(fake.tx.user.update).not.toHaveBeenCalled();
  expect(fake.tx.passwordResetToken.update).not.toHaveBeenCalled();
  expect(fake.tx.authSession.updateMany).not.toHaveBeenCalled();
  expect(fake.tx.auditLog.create).not.toHaveBeenCalled();
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

describe("ResetPassword — happy path", () => {
  it("stores a hash, consumes the token, and revokes every session", async () => {
    const fake = buildFake({ revokedCount: 3 });
    configureBus(fake.client);

    const out = await run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD });

    expect(out.userId).toBe(USER_ID);
    expect(out.sessionsRevoked).toBe(3);

    const userUpdates = fake.tx.user.update.mock.calls as unknown as ReadonlyArray<
      readonly [{ where: { id: string }; data: { hashedPassword: string } }]
    >;
    const stored = userUpdates[0]![0].data.hashedPassword;
    // The column holds the hasher's output. If a regression ever stores
    // the plaintext (or anything reversible), one SELECT on `user`
    // becomes a credential dump for the whole tenant.
    expect(stored).toBe(await fakeHasher.hash(NEW_PASSWORD));
    expect(stored).not.toBe(NEW_PASSWORD);
    const historyWrites = fake.tx.passwordHistory.create.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: { hashedPassword: string } }]
    >;
    expect(historyWrites[0]![0].data.hashedPassword).not.toBe(NEW_PASSWORD);

    // `usedAt` stamped: this is what makes the emailed link single-use.
    expect(fake.tx.passwordResetToken.update).toHaveBeenCalledWith({
      where: { id: TOKEN_ROW_ID },
      data: { usedAt: NOW },
    });

    // A reset means the account may be compromised, so no session the
    // old credential authorized may survive it.
    const revokes = fake.tx.authSession.updateMany.mock.calls as unknown as ReadonlyArray<
      readonly [{ where: { userId: string; revokedAt: null }; data: { revokedReason: string } }]
    >;
    expect(revokes[0]![0].where).toEqual({ userId: USER_ID, revokedAt: null });
    expect(revokes[0]![0].data.revokedReason).toBe("PASSWORD_CHANGED");

    const audits = fake.tx.auditLog.create.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: { action: string; resourceId: string } }]
    >;
    expect(audits[0]![0].data.action).toBe("user.password_reset");
    expect(audits[0]![0].data.resourceId).toBe(USER_ID);

    const outbox = fake.tx.eventOutbox.createMany.mock.calls as unknown as ReadonlyArray<
      readonly [{ data: ReadonlyArray<{ eventType: string }> }]
    >;
    expect(outbox[0]![0].data[0]!.eventType).toBe("user.password_reset.v1");
  });

  it("refuses the same token a second time", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD });

    // Replay with the identical link. If single-use stops holding, a
    // reset link recovered later from an inbox, a proxy log, or a
    // browser history is a standing password-change primitive.
    await expect(
      run({ rawToken: RAW_TOKEN, newPassword: "second-secret-phrase-4" })
    ).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID" });
    expect(fake.tx.user.update).toHaveBeenCalledTimes(1);
  });
});

describe("ResetPassword — token guards", () => {
  it("rejects a token that does not exist", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await expect(
      run({ rawToken: "not-a-token-we-ever-minted", newPassword: NEW_PASSWORD })
    ).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID" });
    expectNoEffect(fake);
  });

  it("rejects an already-used token", async () => {
    const fake = buildFake({ token: { usedAt: new Date(NOW.getTime() - 60_000) } });
    configureBus(fake.client);

    // The `usedAt !== null` clause is the single-use enforcement point.
    // Drop it and every reset link ever mailed becomes replayable
    // forever, including links the operator already redeemed.
    await expect(run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      code: "RESET_TOKEN_INVALID",
    });
    expectNoEffect(fake);
  });

  it("rejects an expired token", async () => {
    const fake = buildFake({ token: { expiresAt: new Date(NOW.getTime() - 1) } });
    configureBus(fake.client);

    // Without the expiry clause a leaked link never stops working, so
    // the 1-hour TTL that bounds the exposure window means nothing.
    await expect(run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      code: "RESET_TOKEN_INVALID",
    });
    expectNoEffect(fake);
  });

  it("rejects a token whose expiry is exactly now", async () => {
    const fake = buildFake({ token: { expiresAt: NOW } });
    configureBus(fake.client);

    // Boundary: the comparison is `expiresAt <= now`, so a token at its
    // exact expiry instant is CLOSED — expiry is exclusive.
    await expect(run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      code: "RESET_TOKEN_INVALID",
    });
    expectNoEffect(fake);
  });

  it("accepts a token one millisecond before expiry", async () => {
    const fake = buildFake({ token: { expiresAt: new Date(NOW.getTime() + 1) } });
    configureBus(fake.client);

    // The other side of the same boundary. Pins the direction of the
    // comparison: an inverted clause would reject every live token
    // and accept every dead one.
    const out = await run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD });
    expect(out.userId).toBe(USER_ID);
  });

  it("rejects a token whose user no longer exists", async () => {
    const fake = buildFake({ userMissing: true });
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      code: "RESET_TOKEN_INVALID",
    });
    expectNoEffect(fake);
  });
});

describe("ResetPassword — account state guard", () => {
  // Reset tokens and invite tokens are the same row shape in
  // `password_reset_token` with no purpose column, so the ACTIVE
  // requirement is the ONLY thing keeping the two flows apart. Without
  // it, an invite token redeemed here sets a password on a still-INVITED
  // user, burns the single-use link, and audits the act as
  // `user.password_reset` — leaving an operator who cannot sign in
  // (SignIn requires ACTIVE) and an onboarding that has to restart.
  it("rejects a token for an operator who is still INVITED", async () => {
    const fake = buildFake({ status: UserStatus.INVITED });
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      code: "RESET_TOKEN_INVALID",
    });
    expectNoEffect(fake);
  });

  // DeactivateUser revokes sessions but does NOT invalidate outstanding
  // reset tokens, so without this guard a link mailed before suspension
  // stays a working credential-rotation primitive after off-boarding.
  it("rejects a token for a SUSPENDED operator", async () => {
    const fake = buildFake({ status: UserStatus.SUSPENDED });
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      code: "RESET_TOKEN_INVALID",
    });
    expectNoEffect(fake);
  });

  it("rejects a token for a TERMINATED operator", async () => {
    const fake = buildFake({ status: UserStatus.TERMINATED });
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      code: "RESET_TOKEN_INVALID",
    });
    expectNoEffect(fake);
  });

  it("uses the SAME opaque code and message for every account state", async () => {
    // The refusal must not distinguish "no such token" from "suspended
    // account": a pre-auth caller holding a stale link would otherwise
    // learn whether the account exists and what state it is in.
    const fingerprints: string[] = [];
    for (const status of [UserStatus.INVITED, UserStatus.SUSPENDED, UserStatus.TERMINATED]) {
      const fake = buildFake({ status });
      configureBus(fake.client);
      fingerprints.push(await refusalFingerprint({ rawToken: RAW_TOKEN }));
      resetCommandBusConfigurationForTests();
    }

    configureBus(buildFake({}).client);
    fingerprints.push(await refusalFingerprint({ rawToken: "never-minted" }));

    expect(new Set(fingerprints).size).toBe(1);
  });
});

describe("ResetPassword — breach screen", () => {
  /** A checker that records whether a transaction was open when it ran. */
  function recordingChecker(
    state: { txOpen: boolean },
    seen: { txOpen: boolean | null; calls: number },
    answer: () => Promise<boolean>
  ): BreachChecker {
    return {
      isBreached: async () => {
        seen.calls += 1;
        seen.txOpen = state.txOpen;
        return answer();
      },
    };
  }

  function configureWithChecker(checker: BreachChecker, timeoutMs?: number): void {
    configureAuth(
      buildAuthConfiguration({
        clock: clock.createFrozenClock(NOW),
        hasher: fakeHasher,
        password: {
          breachChecker: checker,
          ...(timeoutMs === undefined ? {} : { breachCheckTimeoutMs: timeoutMs }),
        },
      })
    );
  }

  it("consults the corpus with NO transaction open", async () => {
    const fake = buildFake({});
    const seen = { txOpen: null as boolean | null, calls: 0 };
    configureWithChecker(recordingChecker(fake.state, seen, async () => false));
    configureBus(fake.client);

    await run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD });

    // The point of the whole arrangement: this is a third-party network
    // call, and a hung provider must not be holding a pooled connection
    // and the row locks the transaction already took.
    expect(seen.calls).toBe(1);
    expect(seen.txOpen).toBe(false);
  });

  it("still rejects a breached password (the verdict is enforced, not just computed)", async () => {
    const fake = buildFake({});
    configureWithChecker({ isBreached: async () => true });
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      code: "PASSWORD_POLICY_VIOLATION",
    });
    // Hoisting the check must not turn it into a no-op, and a rejected
    // attempt must not burn the operator's only link.
    expectNoEffect(fake);
  });

  it("fails OPEN when the checker throws, and records the bypass", async () => {
    const fake = buildFake({});
    configureWithChecker({
      isBreached: () => Promise.reject(new Error("breach corpus unavailable")),
    });
    configureBus(fake.client);

    // A breach-service outage must not stop an operator rotating a
    // credential they may believe is compromised.
    const out = await run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD });
    expect(out.userId).toBe(USER_ID);
    // ...but the skip is on the record. A fail-open nobody can see is
    // how a control quietly stops existing.
    expect(auditMetadata(fake)["breachScreen"]).toBe("bypassed_error");
  });

  it("cuts off a hanging checker at the timeout instead of blocking", async () => {
    const fake = buildFake({});
    // Never settles: the timeout is the only thing that can end this.
    configureWithChecker({ isBreached: () => new Promise<boolean>(() => undefined) }, 25);
    configureBus(fake.client);

    const startedAt = Date.now();
    const out = await run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD });

    expect(out.userId).toBe(USER_ID);
    expect(auditMetadata(fake)["breachScreen"]).toBe("bypassed_timeout");
    // Bounded by the budget, not by the provider. Generous multiple of
    // the 25ms budget so a loaded CI runner cannot make this flake,
    // while a lost timeout (which would hang until vitest's 15s cap)
    // still fails.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("records that no corpus was consulted when none is configured", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD });

    // The default deployment has no checker wired. The audit trail says
    // so rather than implying the password was screened.
    expect(auditMetadata(fake)["breachScreen"]).toBe("not_configured");
  });

  it("records a real verdict when the corpus answers", async () => {
    const fake = buildFake({});
    configureWithChecker({ isBreached: async () => false });
    configureBus(fake.client);

    await run({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD });

    expect(auditMetadata(fake)["breachScreen"]).toBe("checked");
  });
});

describe("ResetPassword — password policy", () => {
  it("leaves the token redeemable when the new password fails policy", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: "short" })).rejects.toMatchObject({
      code: "PASSWORD_POLICY_VIOLATION",
    });
    // Policy runs BEFORE the token is consumed, so a rejected attempt
    // does not burn the operator's only link.
    expectNoEffect(fake);
  });

  it("rejects reuse of the password being reset", async () => {
    const fake = buildFake({});
    configureBus(fake.client);

    await expect(run({ rawToken: RAW_TOKEN, newPassword: OLD_PASSWORD })).rejects.toMatchObject({
      code: "PASSWORD_REUSED",
    });
    expectNoEffect(fake);
  });
});
