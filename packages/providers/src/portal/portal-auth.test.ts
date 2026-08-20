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
import { ClinicStatus, PortalAccountStatus } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

import { changePortalPassword, type ChangePortalPasswordInput } from "./change-password.js";
import {
  PORTAL_SESSION_ABSOLUTE_EXPIRED,
  PORTAL_SESSION_ACCOUNT_DISABLED,
  PORTAL_SESSION_CLIENT_ACCESS_REVOKED,
  PORTAL_SESSION_IDLE_EXPIRED,
  PORTAL_SESSION_NOT_FOUND,
  PORTAL_SESSION_REVOKED,
  resolvePortalSession,
} from "./session.js";
import { PORTAL_NO_ACTIVE_CLINIC, PortalSignIn } from "./sign-in-command.js";
import { setupPortalAccount, type SetupPortalAccountInput } from "./setup-account.js";
import {
  SWITCH_PORTAL_CLINIC_NOT_AFFILIATED,
  SWITCH_PORTAL_CLINIC_SESSION_NOT_FOUND,
  SwitchPortalClinic,
} from "./switch-clinic-command.js";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000b1";
const PROVIDER_ID = "00000000-0000-4000-8000-0000000000c1";
const CLINIC_ID = "00000000-0000-4000-8000-0000000000e1";
const TOKEN_ID = "00000000-0000-4000-8000-0000000000d1";
// Synthetic office contact for the one seeded account — not PHI.
const ACCOUNT_EMAIL = "a.patel@example-practice.test";

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
  /** Clients the prescriber may act for. Empty means sign-in refuses. */
  clinicOptions?: ReadonlyArray<{ id: string; code: string; name: string }>;
}

function buildFake(opts: FakeOptions = {}) {
  const tx = {
    portalSetupToken: {
      findUnique: vi.fn(async () => opts.setupToken ?? null),
      update: vi.fn(async (_args: unknown) => ({})),
    },
    // The fake database holds ONE portal account, and it lives in
    // ORG_ID under ACCOUNT_EMAIL. Both readers answer whatever `where`
    // they are handed the way Postgres would: every clause present must
    // match, and a clause that is ABSENT constrains nothing. So a
    // command that filters on the wrong organization gets a real miss,
    // and one that forgot to filter at all gets a HIT — which is what
    // makes the tenancy tests below fail for the right reason instead
    // of looking like a missing account.
    portalAccount: {
      findFirst: vi.fn(async (args: { where: { id?: string; organizationId?: string } }) =>
        (args.where.id !== undefined && args.where.id !== ACCOUNT_ID) ||
        (args.where.organizationId !== undefined && args.where.organizationId !== ORG_ID)
          ? null
          : (opts.accountById ?? null)
      ),
      findUnique: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const byEmail = args.where["organizationId_email"] as
          { organizationId: string; email: string } | undefined;
        if (byEmail !== undefined) {
          return byEmail.organizationId === ORG_ID && byEmail.email === ACCOUNT_EMAIL
            ? (opts.accountByEmail ?? null)
            : null;
        }
        return args.where["id"] === ACCOUNT_ID ? (opts.accountById ?? null) : null;
      }),
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
      findFirst: vi.fn(async (_args: unknown) => ({
        id: "portal-session-1",
        activeClinicId: null,
      })),
      update: vi.fn(async (_args: unknown) => ({})),
      updateMany: vi.fn(async (_args: unknown) => ({
        count: opts.sessionsRevokedCount ?? 2,
      })),
    },
    // Sign-in resolves which clients the prescriber may act for, to
    // decide whether to mint a scoped session or send them to the
    // chooser. Default is a single affiliation — the common case, and
    // the one that keeps the pre-existing sign-in assertions valid.
    clinicProviderAffiliation: {
      findMany: vi.fn(async (_args: unknown) =>
        (opts.clinicOptions ?? [{ id: CLINIC_ID, code: "DEMO", name: "Demo Clinic" }]).map(
          (clinic) => ({ clinic })
        )
      ),
      findFirst: vi.fn(async (_args: unknown) => ({ id: "affiliation-1" })),
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
  email: ACCOUNT_EMAIL,
  status: PortalAccountStatus.PENDING_SETUP,
  providerId: PROVIDER_ID,
};

// The production wrapper, not a bare dispatch: it screens the chosen
// password against the breach corpus BEFORE the command's transaction
// opens, which is the ordering the command now requires.
function runSetup(overrides: Partial<SetupPortalAccountInput>) {
  return setupPortalAccount({ rawToken: "tok-raw", newPassword: "x", ...overrides });
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

/**
 * `code|message` of the refusal, so two failure paths can be compared
 * for indistinguishability rather than merely both being errors.
 */
async function setupRefusalFingerprint(): Promise<string> {
  try {
    await runSetup({ newPassword: "correct horse battery staple" });
  } catch (cause) {
    const err = cause as { code: string; message: string };
    return `${err.code}|${err.message}`;
  }
  return "<did not reject>";
}

/** Neither the credential, the status, nor the token moved. */
function expectNoSetupEffect(fake: ReturnType<typeof buildFake>): void {
  expect(fake.tx.portalAccount.update).not.toHaveBeenCalled();
  expect(fake.tx.portalSetupToken.update).not.toHaveBeenCalled();
  expect(fake.tx.auditLog.create).not.toHaveBeenCalled();
  expect(fake.tx.eventOutbox.createMany).not.toHaveBeenCalled();
}

// The token row is where this command learns which organization to write
// under: `targetOrganizationId`, the audit entry, and the
// `provider.portal_account.activated.v1` payload all come from it. So a
// row whose `organizationId` does not match its account's would file one
// tenant's activation in another tenant's audit trail and event stream —
// the two artifacts that are supposed to be tenant-scoped truth, and the
// kind of cross-tenant write the repo treats as a critical incident.
//
// IssuePortalSetupToken proves that pairing before it mints, so this is
// defence in depth rather than a live exploit: a future writer to
// `portal_setup_token` would not necessarily repeat the membership
// check.
describe("SetupPortalAccount — tenancy", () => {
  it("refuses a token whose organization is not the account's", async () => {
    // The account row lives in ORG_ID; the token claims OTHER_ORG_ID.
    const fake = buildFake({
      setupToken: { ...VALID_TOKEN, organizationId: OTHER_ORG_ID },
      accountById: PENDING_ACCOUNT,
    });
    configureBus(fake.client);

    await expect(runSetup({ newPassword: "correct horse battery staple" })).rejects.toMatchObject({
      code: "PORTAL_SETUP_TOKEN_INVALID",
    });
  });

  it("writes nothing at all when it refuses a mismatched token", async () => {
    const fake = buildFake({
      setupToken: { ...VALID_TOKEN, organizationId: OTHER_ORG_ID },
      accountById: PENDING_ACCOUNT,
    });
    configureBus(fake.client);

    await expect(runSetup({ newPassword: "correct horse battery staple" })).rejects.toThrow();

    // No credential, no activation, no consumed link, no audit row and
    // no event — and because a system command resolves its target org
    // inside the handler, no command_log row under OTHER_ORG_ID either.
    // A refusal that still filed bookkeeping under the token's claimed
    // organization would itself be the cross-tenant write.
    expectNoSetupEffect(fake);
    expect(fake.tx.commandLog.create).not.toHaveBeenCalled();
  });

  it("looks the account up with the organization filter, not by id alone", async () => {
    const fake = buildFake({ setupToken: VALID_TOKEN, accountById: PENDING_ACCOUNT });
    configureBus(fake.client);

    await runSetup({ newPassword: "correct horse battery staple" });

    // Pins the mechanism, not just the outcome: the guard is one
    // org-scoped read, so a foreign row is never loaded at all rather
    // than fetched by id and compared afterwards. `findFirst` because
    // `portal_account` has no compound unique on (id, organizationId).
    expect(fake.tx.portalAccount.findFirst).toHaveBeenCalledWith({
      where: { id: ACCOUNT_ID, organizationId: ORG_ID },
      select: { id: true, email: true, status: true, providerId: true },
    });
  });

  it("uses the SAME opaque code and message for every refusal, tenancy included", async () => {
    // A caller here is anonymous — it holds an emailed link and nothing
    // else. If the organization mismatch had its own code, that caller
    // would learn that the token names a real account in a real (other)
    // organization, which is exactly the cross-tenant existence oracle
    // the shared refusal exists to deny.
    const fingerprints: string[] = [];
    const cases = [
      buildFake({
        setupToken: { ...VALID_TOKEN, organizationId: OTHER_ORG_ID },
        accountById: PENDING_ACCOUNT,
      }),
      buildFake({
        setupToken: VALID_TOKEN,
        accountById: { ...PENDING_ACCOUNT, status: PortalAccountStatus.ACTIVE },
      }),
      buildFake({
        setupToken: VALID_TOKEN,
        accountById: { ...PENDING_ACCOUNT, status: PortalAccountStatus.DISABLED },
      }),
      buildFake({ setupToken: VALID_TOKEN, accountById: null }),
      buildFake({
        setupToken: { ...VALID_TOKEN, usedAt: new Date(NOW.getTime() - 1) },
        accountById: PENDING_ACCOUNT,
      }),
      buildFake({
        setupToken: { ...VALID_TOKEN, expiresAt: new Date(NOW.getTime() - 1) },
        accountById: PENDING_ACCOUNT,
      }),
      buildFake({ setupToken: null }),
    ];
    for (const fake of cases) {
      configureBus(fake.client);
      fingerprints.push(await setupRefusalFingerprint());
      resetCommandBusConfigurationForTests();
    }

    // Compared against the literal rather than merely "all equal", so
    // this cannot pass by every case failing to reject at all.
    expect([...new Set(fingerprints)]).toEqual([
      "PORTAL_SETUP_TOKEN_INVALID|This setup link is invalid or has expired.",
    ]);
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
      email: ACCOUNT_EMAIL,
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
  email: ACCOUNT_EMAIL,
  hashedPassword: "h:current-password-9",
  status: PortalAccountStatus.ACTIVE,
};

function runChange(overrides: Partial<ChangePortalPasswordInput>) {
  return changePortalPassword({
    portalAccountId: ACCOUNT_ID,
    currentPassword: "current-password-9",
    newPassword: "correct horse battery staple",
    ...overrides,
  });
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
  portalAccount: {
    status: PortalAccountStatus;
    providerId: string;
    organizationId: string;
  };
  activeClinicId: string | null;
  activeClinic: { id: string; status: ClinicStatus } | null;
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
    // The joined account row. Its organization is the one the session's
    // own `organizationId` has to agree with.
    portalAccount: {
      status: PortalAccountStatus.ACTIVE,
      providerId: PROVIDER_ID,
      organizationId: ORG_ID,
    },
    // Default is a session scoped to a live client, which is the shape
    // every pre-existing assertion in this file was written against.
    activeClinicId: CLINIC_ID,
    activeClinic: { id: CLINIC_ID, status: ClinicStatus.ACTIVE },
    ...overrides,
  };
}

function sessionClient(row: SessionRow | null, opts: { affiliated?: boolean } = {}) {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    portalSession: {
      findUnique: vi.fn(async (_args: unknown) => row),
      update: vi.fn(async (_args: unknown) => ({})),
    },
    // Client access is re-proven on every resolve, so the resolve path
    // reads this too.
    clinicProviderAffiliation: {
      findFirst: vi.fn(async (_args: unknown) =>
        (opts.affiliated ?? true) ? { id: "affiliation-1" } : null
      ),
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
        portalAccount: {
          status: PortalAccountStatus.DISABLED,
          providerId: PROVIDER_ID,
          organizationId: ORG_ID,
        },
      })
    );
    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });
    expect(result).toEqual({ ok: false, reason: PORTAL_SESSION_ACCOUNT_DISABLED });
  });

  // The organization this returns is the tenancy scope every /portal
  // read and write then runs under (the profile route builds its
  // tenancy context straight from it). A session row whose
  // `organizationId` disagreed with its account's would therefore scope
  // one tenant's request to another — so the pairing is proven here, not
  // assumed, and a mismatch is the same opaque refusal as an unknown
  // token.
  it("refuses a session whose organization is not its account's", async () => {
    const { client, tx } = sessionClient(
      sessionRow({
        // Session filed under ORG_ID; the account it points at lives in
        // OTHER_ORG_ID.
        portalAccount: {
          status: PortalAccountStatus.ACTIVE,
          providerId: PROVIDER_ID,
          organizationId: OTHER_ORG_ID,
        },
      })
    );
    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });

    // Indistinguishable from a token that was never minted, and no
    // write: a row whose tenancy cannot be proven is not one to file
    // bookkeeping against.
    expect(result).toEqual({ ok: false, reason: PORTAL_SESSION_NOT_FOUND });
    expect(tx.portalSession.update).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------
// Multi-client affiliations.
//
// A prescriber commonly writes for several client practices, and the
// active one decides which orders the session may read and which
// practice the pharmacy bills. These suites cover the three places that
// scope is decided: minted at sign-in, re-proven on every resolve, and
// changed by an explicit switch.
// ---------------------------------------------------------------------

const SECOND_CLINIC_ID = "00000000-0000-4000-8000-0000000000e2";

describe("PortalSignIn — client scope at mint time", () => {
  it("mints a session already scoped when the prescriber has exactly one client", async () => {
    const fake = buildFake({ accountByEmail: ACTIVE_ACCOUNT });
    configureBus(fake.client);

    const out = await runSignIn({});

    expect(out.activeClinicId).toBe(CLINIC_ID);
    expect(out.clinicOptionCount).toBe(1);

    const create = fake.tx.portalSession.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(create.data["activeClinicId"]).toBe(CLINIC_ID);
  });

  it("leaves the session unscoped when several clients are available", async () => {
    const fake = buildFake({
      accountByEmail: ACTIVE_ACCOUNT,
      clinicOptions: [
        { id: CLINIC_ID, code: "VALLEY", name: "Valley Wellness" },
        { id: SECOND_CLINIC_ID, code: "COASTAL", name: "Coastal Med" },
      ],
    });
    configureBus(fake.client);

    const out = await runSignIn({});

    // Null is the signal the web tier routes on: send them to the
    // chooser rather than guessing which practice they meant.
    expect(out.activeClinicId).toBeNull();
    expect(out.clinicOptionCount).toBe(2);

    const create = fake.tx.portalSession.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(create.data["activeClinicId"]).toBeNull();
  });

  it("refuses sign-in with no active client, distinctly from bad credentials", async () => {
    const fake = buildFake({ accountByEmail: ACTIVE_ACCOUNT, clinicOptions: [] });
    configureBus(fake.client);

    // NOT folded into INVALID_CREDENTIALS: authentication succeeded.
    // Telling a prescriber whose practice was just deactivated that
    // their password is wrong sends them to reset a working password.
    await expect(runSignIn({})).rejects.toMatchObject({ code: PORTAL_NO_ACTIVE_CLINIC });
    expect(fake.tx.portalSession.create).not.toHaveBeenCalled();
  });
});

describe("resolvePortalSession — client access re-proven per request", () => {
  it("revokes and refuses a session whose client was deactivated", async () => {
    const { client, tx } = sessionClient(
      sessionRow({ activeClinic: { id: CLINIC_ID, status: ClinicStatus.INACTIVE } })
    );

    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });

    expect(result).toEqual({ ok: false, reason: PORTAL_SESSION_CLIENT_ACCESS_REVOKED });
    const update = tx.portalSession.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(update.data["revokedReason"]).toBe("ADMIN_REVOKED");
  });

  it("revokes and refuses a session whose affiliation was ended", async () => {
    // Client still ACTIVE; the prescriber's affiliation with it is gone.
    const { client, tx } = sessionClient(sessionRow(), { affiliated: false });

    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });

    expect(result).toEqual({ ok: false, reason: PORTAL_SESSION_CLIENT_ACCESS_REVOKED });
    expect(tx.portalSession.update).toHaveBeenCalled();
  });

  it("scopes the affiliation re-check to the session's org, client and provider", async () => {
    const { client, tx } = sessionClient(sessionRow());
    await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });

    const call = tx.clinicProviderAffiliation.findFirst.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(call.where["organizationId"]).toBe(ORG_ID);
    expect(call.where["clinicId"]).toBe(CLINIC_ID);
    expect(call.where["providerId"]).toBe(PROVIDER_ID);
  });

  it("returns the active client so callers can scope their reads", async () => {
    const { client } = sessionClient(sessionRow());
    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.activeClinicId).toBe(CLINIC_ID);
  });

  it("skips the client check entirely for an unscoped session", async () => {
    // Straight after sign-in with several affiliations: nothing to
    // re-prove yet, and the chooser is the only page that will accept it.
    const { client, tx } = sessionClient(sessionRow({ activeClinicId: null, activeClinic: null }));

    const result = await resolvePortalSession({
      rawToken: "tok",
      client: client as never,
      config: sessionConfig(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.activeClinicId).toBeNull();
    expect(tx.clinicProviderAffiliation.findFirst).not.toHaveBeenCalled();
  });
});

describe("SwitchPortalClinic", () => {
  function runSwitch(overrides: Record<string, unknown> = {}) {
    return withSystemContext("test:switch", () =>
      executeSystemCommand(SwitchPortalClinic, {
        sessionId: "00000000-0000-4000-8000-0000000000f1",
        organizationId: ORG_ID,
        portalAccountId: ACCOUNT_ID,
        providerId: PROVIDER_ID,
        clinicId: SECOND_CLINIC_ID,
        ...overrides,
      })
    );
  }

  function switchFake(opts: { current?: unknown; affiliated?: boolean } = {}) {
    const fake = buildFake({ accountByEmail: ACTIVE_ACCOUNT });
    fake.tx.portalSession.findFirst = vi.fn(async (_args: unknown) =>
      opts.current === undefined
        ? { id: "00000000-0000-4000-8000-0000000000f1", activeClinicId: CLINIC_ID }
        : opts.current
    ) as typeof fake.tx.portalSession.findFirst;
    fake.tx.clinicProviderAffiliation.findFirst = vi.fn(async (_args: unknown) =>
      (opts.affiliated ?? true) ? { id: "affiliation-1" } : null
    ) as typeof fake.tx.clinicProviderAffiliation.findFirst;
    return fake;
  }

  it("revokes the old session with SCOPE_CHANGED and mints a new scoped one", async () => {
    const fake = switchFake();
    configureBus(fake.client);

    const out = await runSwitch();

    expect(out.clinicId).toBe(SECOND_CLINIC_ID);
    expect(out.previousClinicId).toBe(CLINIC_ID);
    expect(out.rawToken).toEqual(expect.any(String));

    // Revoke-and-re-mint, not an in-place edit: one token means one
    // client for the token's whole life.
    const revoke = fake.tx.portalSession.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(revoke.data["revokedReason"]).toBe("SCOPE_CHANGED");
    expect(revoke.data["revokedAt"]).toBeInstanceOf(Date);

    const create = fake.tx.portalSession.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(create.data["activeClinicId"]).toBe(SECOND_CLINIC_ID);
  });

  it("emits client_switched.v1 carrying both session ids", async () => {
    const fake = switchFake();
    configureBus(fake.client);

    await runSwitch();

    expect(outboxTypesOf(fake.tx)).toEqual(["provider.portal_session.client_switched.v1"]);
  });

  it("refuses a client the prescriber is not affiliated with, leaving the session intact", async () => {
    const fake = switchFake({ affiliated: false });
    configureBus(fake.client);

    await expect(runSwitch()).rejects.toMatchObject({
      code: SWITCH_PORTAL_CLINIC_NOT_AFFILIATED,
    });
    // The old session must survive a refused switch — otherwise a bad
    // request logs the prescriber out.
    expect(fake.tx.portalSession.update).not.toHaveBeenCalled();
    expect(fake.tx.portalSession.create).not.toHaveBeenCalled();
  });

  it("refuses when the session is not live, or is not this account's", async () => {
    // The lookup filters on (id, organizationId, portalAccountId,
    // revokedAt: null); a miss covers every one of those.
    const fake = switchFake({ current: null });
    configureBus(fake.client);

    await expect(runSwitch()).rejects.toMatchObject({
      code: SWITCH_PORTAL_CLINIC_SESSION_NOT_FOUND,
    });
    expect(fake.tx.portalSession.create).not.toHaveBeenCalled();
  });

  it("binds the session lookup to the claiming account, not the id alone", async () => {
    const fake = switchFake();
    configureBus(fake.client);

    await runSwitch();

    const call = fake.tx.portalSession.findFirst.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    // Without portalAccountId, a leaked session id would be enough to
    // re-scope somebody else's session.
    expect(call.where["portalAccountId"]).toBe(ACCOUNT_ID);
    expect(call.where["organizationId"]).toBe(ORG_ID);
    expect(call.where["revokedAt"]).toBeNull();
  });
});
