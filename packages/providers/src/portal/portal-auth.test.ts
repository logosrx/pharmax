// Portal auth contract tests (ADR-0033, slice 2) — DB-free, bus-
// integrated, fake hasher + frozen clock.
//
// Invariants pinned here:
//
//   1. SetupPortalAccount consumes the token, enforces the password
//      policy, flips PENDING_SETUP → ACTIVE, and answers EVERY
//      not-consumable case (missing / expired / used token, account
//      not PENDING_SETUP) with ONE opaque PORTAL_SETUP_TOKEN_INVALID.
//   2. PortalSignIn issues a session only for an ACTIVE account with
//      a verifying password; every failure is the same opaque
//      INVALID_CREDENTIALS (no enumeration). Only the token HASH is
//      persisted.
//   3. resolvePortalSession: valid slides; revoked / idle-expired /
//      absolute-expired / non-ACTIVE account are rejected (and
//      auto-revoked where applicable).
//
// All identifiers below are synthetic.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthConfiguration,
  configureAuth,
  hashSessionToken,
  resetAuthConfigurationForTests,
  type PasswordHasher,
} from "@pharmax/auth";
import {
  configureCommandBus,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { PortalAccountStatus } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

import { ChangePortalPassword } from "./change-password.js";
import {
  PORTAL_SESSION_ABSOLUTE_EXPIRED,
  PORTAL_SESSION_ACCOUNT_DISABLED,
  PORTAL_SESSION_IDLE_EXPIRED,
  PORTAL_SESSION_NOT_FOUND,
  PORTAL_SESSION_REVOKED,
  resolvePortalSession,
} from "./session.js";
import { PortalSignIn } from "./sign-in-command.js";
import { SetupPortalAccount } from "./setup-account.js";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000b1";
const PROVIDER_ID = "00000000-0000-4000-8000-0000000000c1";
const TOKEN_ID = "00000000-0000-4000-8000-0000000000d1";

// Deterministic fake: a stored hash "h:<plaintext>" verifies that
// plaintext (Argon2id itself is covered in the auth package).
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

beforeEach(() => {
  configureAuth(
    buildAuthConfiguration({ clock: clock.createFrozenClock(NOW), hasher: fakeHasher })
  );
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetAuthConfigurationForTests();
});

// ---------------------------------------------------------------------
// Fake Prisma (command-bus shape)
// ---------------------------------------------------------------------

interface FakeOptions {
  setupToken?: Record<string, unknown> | null;
  accountById?: Record<string, unknown> | null;
  accountByEmail?: Record<string, unknown> | null;
  passwordHistory?: Array<{ hashedPassword: string }>;
  sessionsRevokedCount?: number;
}

function buildFake(opts: FakeOptions = {}) {
  const tx = {
    portalSetupToken: {
      findUnique: vi.fn(async () => opts.setupToken ?? null),
      update: vi.fn(async (_args: unknown) => ({})),
    },
    portalAccount: {
      findUnique: vi.fn(async (args: { where: Record<string, unknown> }) =>
        "id" in args.where ? (opts.accountById ?? null) : (opts.accountByEmail ?? null)
      ),
      update: vi.fn(async (_args: unknown) => ({ id: ACCOUNT_ID })),
    },
    portalPasswordHistory: {
      findMany: vi.fn(async (args: { take?: number; select?: Record<string, unknown> }) => {
        const rows = opts.passwordHistory ?? [];
        // Second findMany (the prune read) selects ids; return
        // id-shaped rows for it.
        if (args.select !== undefined && "id" in args.select) {
          return rows.map((_, index) => ({ id: `hist-${index}` }));
        }
        return rows;
      }),
      create: vi.fn(async (_args: unknown) => ({})),
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
    },
    portalSession: {
      create: vi.fn(async (_args: unknown) => ({ id: "portal-session-1" })),
      updateMany: vi.fn(async (_args: unknown) => ({
        count: opts.sessionsRevokedCount ?? 2,
      })),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cmd-log-1" })),
      update: vi.fn(async () => ({})),
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
    eventOutbox: {
      createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })),
    },
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

function outboxTypesOf(tx: ReturnType<typeof buildFake>["tx"]): string[] {
  return tx.eventOutbox.createMany.mock.calls.flatMap((call) =>
    (call[0] as { data: Array<{ eventType: string }> }).data.map((d) => d.eventType)
  );
}

// ---------------------------------------------------------------------
// SetupPortalAccount
// ---------------------------------------------------------------------

const VALID_TOKEN = {
  id: TOKEN_ID,
  portalAccountId: ACCOUNT_ID,
  organizationId: ORG_ID,
  expiresAt: new Date(NOW.getTime() + 60_000),
  usedAt: null,
};

const PENDING_ACCOUNT = {
  id: ACCOUNT_ID,
  email: "a.patel@example-practice.test",
  status: PortalAccountStatus.PENDING_SETUP,
  providerId: PROVIDER_ID,
};

function runSetup(input: Record<string, unknown>) {
  return withSystemContext("test:portal-setup", () =>
    executeSystemCommand(SetupPortalAccount, { rawToken: "tok-raw", newPassword: "x", ...input })
  );
}

describe("SetupPortalAccount", () => {
  it("activates the account, hashes the password, consumes the token, emits activated.v1", async () => {
    const fake = buildFake({ setupToken: VALID_TOKEN, accountById: PENDING_ACCOUNT });
    configureBus(fake.client);

    const out = await runSetup({ newPassword: "correct horse battery staple" });

    expect(out.portalAccountId).toBe(ACCOUNT_ID);
    expect(out.organizationId).toBe(ORG_ID);

    const accountUpdate = fake.tx.portalAccount.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(accountUpdate.data["status"]).toBe(PortalAccountStatus.ACTIVE);
    expect(accountUpdate.data["hashedPassword"]).toBe("h:correct horse battery staple");

    const tokenUpdate = fake.tx.portalSetupToken.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(tokenUpdate.data["usedAt"]).toEqual(NOW);

    expect(outboxTypesOf(fake.tx)).toEqual(["provider.portal_account.activated.v1"]);
  });

  it("rejects an unknown token with the opaque invalid-token error", async () => {
    const fake = buildFake({ setupToken: null });
    configureBus(fake.client);
    await expect(runSetup({ newPassword: "correct horse battery staple" })).rejects.toMatchObject({
      code: "PORTAL_SETUP_TOKEN_INVALID",
    });
  });

  it("rejects an expired token with the same opaque error", async () => {
    const fake = buildFake({
      setupToken: { ...VALID_TOKEN, expiresAt: new Date(NOW.getTime() - 1) },
      accountById: PENDING_ACCOUNT,
    });
    configureBus(fake.client);
    await expect(runSetup({ newPassword: "correct horse battery staple" })).rejects.toMatchObject({
      code: "PORTAL_SETUP_TOKEN_INVALID",
    });
  });

  it("rejects an already-used token with the same opaque error", async () => {
    const fake = buildFake({
      setupToken: { ...VALID_TOKEN, usedAt: new Date(NOW.getTime() - 1) },
      accountById: PENDING_ACCOUNT,
    });
    configureBus(fake.client);
    await expect(runSetup({ newPassword: "correct horse battery staple" })).rejects.toMatchObject({
      code: "PORTAL_SETUP_TOKEN_INVALID",
    });
  });

  it("rejects a non-PENDING_SETUP account with the same opaque error (no enumeration)", async () => {
    const fake = buildFake({
      setupToken: VALID_TOKEN,
      accountById: { ...PENDING_ACCOUNT, status: PortalAccountStatus.ACTIVE },
    });
    configureBus(fake.client);
    await expect(runSetup({ newPassword: "correct horse battery staple" })).rejects.toMatchObject({
      code: "PORTAL_SETUP_TOKEN_INVALID",
    });
  });

  it("enforces the password policy (too short) without consuming the token", async () => {
    const fake = buildFake({ setupToken: VALID_TOKEN, accountById: PENDING_ACCOUNT });
    configureBus(fake.client);
    await expect(runSetup({ newPassword: "short" })).rejects.toMatchObject({
      code: "PASSWORD_POLICY_VIOLATION",
    });
    expect(fake.tx.portalAccount.update).not.toHaveBeenCalled();
    expect(fake.tx.portalSetupToken.update).not.toHaveBeenCalled();
  });

  it("rejects a password containing the email local-part", async () => {
    const fake = buildFake({ setupToken: VALID_TOKEN, accountById: PENDING_ACCOUNT });
    configureBus(fake.client);
    await expect(runSetup({ newPassword: "xxa.patelxx-longenough" })).rejects.toMatchObject({
      code: "PASSWORD_POLICY_VIOLATION",
    });
  });
});

// ---------------------------------------------------------------------
// PortalSignIn
// ---------------------------------------------------------------------

const ACTIVE_ACCOUNT = {
  id: ACCOUNT_ID,
  providerId: PROVIDER_ID,
  status: PortalAccountStatus.ACTIVE,
  hashedPassword: "h:correct-password",
};

function runSignIn(input: Record<string, unknown>) {
  return withSystemContext("test:portal-sign-in", () =>
    executeSystemCommand(PortalSignIn, {
      organizationId: ORG_ID,
      email: "a.patel@example-practice.test",
      password: "correct-password",
      ...input,
    })
  );
}

describe("PortalSignIn", () => {
  it("issues a session (hash-only at rest) and emits signed_in.v1", async () => {
    const fake = buildFake({ accountByEmail: ACTIVE_ACCOUNT });
    configureBus(fake.client);

    const out = await runSignIn({});

    expect(out.portalAccountId).toBe(ACCOUNT_ID);
    expect(out.providerId).toBe(PROVIDER_ID);
    expect(out.sessionId).toBe("portal-session-1");
    expect(out.rawToken).toEqual(expect.any(String));

    const sessionCreate = fake.tx.portalSession.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(sessionCreate.data["tokenHash"]).toBe(hashSessionToken(out.rawToken));
    expect(Object.values(sessionCreate.data)).not.toContain(out.rawToken);

    // lastLoginAt stamped.
    expect(fake.tx.portalAccount.update).toHaveBeenCalledTimes(1);
    expect(outboxTypesOf(fake.tx)).toEqual(["provider.portal_account.signed_in.v1"]);
  });

  it("rejects a wrong password with opaque INVALID_CREDENTIALS", async () => {
    const fake = buildFake({ accountByEmail: ACTIVE_ACCOUNT });
    configureBus(fake.client);
    await expect(runSignIn({ password: "WRONG" })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(fake.tx.portalSession.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown email with the same opaque error", async () => {
    const fake = buildFake({ accountByEmail: null });
    configureBus(fake.client);
    await expect(runSignIn({ email: "ghost@example.test" })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
  });

  it("rejects a PENDING_SETUP account with the same opaque error", async () => {
    const fake = buildFake({
      accountByEmail: {
        ...ACTIVE_ACCOUNT,
        status: PortalAccountStatus.PENDING_SETUP,
        hashedPassword: null,
      },
    });
    configureBus(fake.client);
    await expect(runSignIn({})).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("rejects a DISABLED account with the same opaque error", async () => {
    const fake = buildFake({
      accountByEmail: { ...ACTIVE_ACCOUNT, status: PortalAccountStatus.DISABLED },
    });
    configureBus(fake.client);
    await expect(runSignIn({})).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(fake.tx.portalSession.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// ChangePortalPassword
// ---------------------------------------------------------------------

const CHANGE_ACCOUNT = {
  id: ACCOUNT_ID,
  organizationId: ORG_ID,
  providerId: PROVIDER_ID,
  email: "a.patel@example-practice.test",
  hashedPassword: "h:current-password-9",
  status: PortalAccountStatus.ACTIVE,
};

function runChange(input: Record<string, unknown>) {
  return withSystemContext("test:portal-change-password", () =>
    executeSystemCommand(ChangePortalPassword, {
      portalAccountId: ACCOUNT_ID,
      currentPassword: "current-password-9",
      newPassword: "correct horse battery staple",
      ...input,
    })
  );
}

describe("ChangePortalPassword", () => {
  it("stores the new hash, appends history, revokes other sessions, emits password_changed.v1", async () => {
    const fake = buildFake({ accountById: CHANGE_ACCOUNT, sessionsRevokedCount: 3 });
    configureBus(fake.client);

    const out = await runChange({ exceptSessionId: "00000000-0000-4000-8000-0000000000e1" });

    expect(out.portalAccountId).toBe(ACCOUNT_ID);
    expect(out.sessionsRevoked).toBe(3);

    const accountUpdate = fake.tx.portalAccount.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(accountUpdate.data["hashedPassword"]).toBe("h:correct horse battery staple");

    const historyCreate = fake.tx.portalPasswordHistory.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(historyCreate.data["portalAccountId"]).toBe(ACCOUNT_ID);
    expect(historyCreate.data["hashedPassword"]).toBe("h:correct horse battery staple");

    // Other sessions revoked; the caller's own survives.
    const revoke = fake.tx.portalSession.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(revoke.where["portalAccountId"]).toBe(ACCOUNT_ID);
    expect(revoke.where["id"]).toEqual({ not: "00000000-0000-4000-8000-0000000000e1" });
    expect(revoke.data["revokedReason"]).toBe("PASSWORD_CHANGED");

    expect(outboxTypesOf(fake.tx)).toEqual(["provider.portal_account.password_changed.v1"]);
  });

  it("rejects a wrong current password with the opaque code and writes nothing", async () => {
    const fake = buildFake({ accountById: CHANGE_ACCOUNT });
    configureBus(fake.client);
    await expect(runChange({ currentPassword: "WRONG" })).rejects.toMatchObject({
      code: "PORTAL_CURRENT_PASSWORD_INVALID",
    });
    expect(fake.tx.portalAccount.update).not.toHaveBeenCalled();
    expect(fake.tx.portalSession.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a non-ACTIVE account with the same opaque code (no enumeration)", async () => {
    const fake = buildFake({
      accountById: { ...CHANGE_ACCOUNT, status: PortalAccountStatus.DISABLED },
    });
    configureBus(fake.client);
    await expect(runChange({})).rejects.toMatchObject({
      code: "PORTAL_CURRENT_PASSWORD_INVALID",
    });
  });

  it("enforces the password policy on the new password", async () => {
    const fake = buildFake({ accountById: CHANGE_ACCOUNT });
    configureBus(fake.client);
    await expect(runChange({ newPassword: "short" })).rejects.toMatchObject({
      code: "PASSWORD_POLICY_VIOLATION",
    });
    expect(fake.tx.portalAccount.update).not.toHaveBeenCalled();
  });

  it("rejects reusing the CURRENT password", async () => {
    const fake = buildFake({ accountById: CHANGE_ACCOUNT });
    configureBus(fake.client);
    await expect(runChange({ newPassword: "current-password-9" })).rejects.toMatchObject({
      code: "PASSWORD_REUSED",
    });
    expect(fake.tx.portalAccount.update).not.toHaveBeenCalled();
  });

  it("rejects reusing a password from the history window", async () => {
    const fake = buildFake({
      accountById: CHANGE_ACCOUNT,
      passwordHistory: [{ hashedPassword: "h:previous-password-8" }],
    });
    configureBus(fake.client);
    await expect(runChange({ newPassword: "previous-password-8" })).rejects.toMatchObject({
      code: "PASSWORD_REUSED",
    });
  });
});

// ---------------------------------------------------------------------
// resolvePortalSession
// ---------------------------------------------------------------------

interface SessionRow {
  id: string;
  portalAccountId: string;
  organizationId: string;
  lastActivityAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  portalAccount: { status: PortalAccountStatus; providerId: string };
}

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "portal-session-1",
    portalAccountId: ACCOUNT_ID,
    organizationId: ORG_ID,
    lastActivityAt: NOW,
    idleExpiresAt: new Date(NOW.getTime() + 60_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 3_600_000),
    revokedAt: null,
    portalAccount: { status: PortalAccountStatus.ACTIVE, providerId: PROVIDER_ID },
    ...overrides,
  };
}

function sessionClient(row: SessionRow | null) {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    portalSession: {
      findUnique: vi.fn(async (_args: unknown) => row),
      update: vi.fn(async (_args: unknown) => ({})),
    },
  };
  const client = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { client, tx };
}

function sessionConfig() {
  return buildAuthConfiguration({ clock: clock.createFrozenClock(NOW), hasher: fakeHasher });
}

describe("resolvePortalSession", () => {
  it("resolves a valid session with the provider identity", async () => {
    const { client } = sessionClient(sessionRow());
    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.portalAccountId).toBe(ACCOUNT_ID);
      expect(result.session.providerId).toBe(PROVIDER_ID);
      expect(result.session.organizationId).toBe(ORG_ID);
    }
  });

  it("rejects an unknown token", async () => {
    const { client } = sessionClient(null);
    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });
    expect(result).toEqual({ ok: false, reason: PORTAL_SESSION_NOT_FOUND });
  });

  it("rejects a revoked session", async () => {
    const { client } = sessionClient(sessionRow({ revokedAt: new Date(NOW.getTime() - 1) }));
    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });
    expect(result).toEqual({ ok: false, reason: PORTAL_SESSION_REVOKED });
  });

  it("auto-revokes and rejects an idle-expired session", async () => {
    const { client, tx } = sessionClient(
      sessionRow({ idleExpiresAt: new Date(NOW.getTime() - 1) })
    );
    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });
    expect(result).toEqual({ ok: false, reason: PORTAL_SESSION_IDLE_EXPIRED });
    const update = tx.portalSession.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(update.data["revokedReason"]).toBe("IDLE_TIMEOUT");
  });

  it("auto-revokes and rejects an absolute-expired session", async () => {
    const { client, tx } = sessionClient(
      sessionRow({ absoluteExpiresAt: new Date(NOW.getTime() - 1) })
    );
    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });
    expect(result).toEqual({ ok: false, reason: PORTAL_SESSION_ABSOLUTE_EXPIRED });
    const update = tx.portalSession.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(update.data["revokedReason"]).toBe("ABSOLUTE_TIMEOUT");
  });

  it("auto-revokes and rejects a session whose account is no longer ACTIVE", async () => {
    const { client } = sessionClient(
      sessionRow({
        portalAccount: { status: PortalAccountStatus.DISABLED, providerId: PROVIDER_ID },
      })
    );
    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });
    expect(result).toEqual({ ok: false, reason: PORTAL_SESSION_ACCOUNT_DISABLED });
  });

  it("slides the idle window on activity past the write throttle", async () => {
    const { client, tx } = sessionClient(
      sessionRow({ lastActivityAt: new Date(NOW.getTime() - 120_000) })
    );
    const config = sessionConfig();
    const result = await resolvePortalSession({ rawToken: "tok", client: client as never, config });
    expect(result.ok).toBe(true);
    const update = tx.portalSession.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect((update.data["idleExpiresAt"] as Date).getTime()).toBe(
      NOW.getTime() + config.session.idleTtlMs
    );
  });
});
