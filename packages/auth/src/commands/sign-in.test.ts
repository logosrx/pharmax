// SignIn contract tests (bus-integrated, DB-free).
//
// Runs the command through `executeSystemCommand` against a mocked
// Prisma client + a fast fake hasher (Argon2id itself is covered in
// argon2-hasher.test.ts). Asserts the login path: password verify,
// generic rejection of bad/inactive/no-password credentials, the MFA
// floor (required-not-enrolled / required-no-code), and the happy-path
// session + audit shape.

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
import { SignIn } from "./sign-in.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";

// Deterministic fake: a stored hash of "h:<plaintext>" verifies that
// plaintext. `needsRehash` is false so the happy path issues no rehash.
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

interface SeedUser {
  readonly status?: UserStatus;
  readonly hashedPassword?: string | null;
  readonly mfaEnrolled?: boolean;
}

function buildFake(opts: {
  user?: SeedUser | null;
  roleCodes?: ReadonlyArray<string>;
  enrollment?: { id: string; secretCiphertext: string } | null;
}) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];
  const record = (table: string, op: string, args?: unknown) => calls.push({ table, op, args });

  const seededUser =
    opts.user === null
      ? null
      : {
          id: USER_ID,
          status: opts.user?.status ?? UserStatus.ACTIVE,
          hashedPassword:
            opts.user?.hashedPassword === undefined
              ? "h:correct-password"
              : opts.user.hashedPassword,
          mfaEnrolled: opts.user?.mfaEnrolled ?? false,
        };

  const tx = {
    user: {
      findUnique: vi.fn(async (args: unknown) => {
        record("user", "findUnique", args);
        return seededUser;
      }),
      update: vi.fn(async (args: unknown) => {
        record("user", "update", args);
        return {};
      }),
    },
    userRole: {
      findMany: vi.fn(async (args: unknown) => {
        record("userRole", "findMany", args);
        return (opts.roleCodes ?? []).map((code) => ({ role: { code } }));
      }),
    },
    mfaEnrollment: {
      findFirst: vi.fn(async (args: unknown) => {
        record("mfaEnrollment", "findFirst", args);
        return opts.enrollment ?? null;
      }),
    },
    recoveryCode: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    authSession: {
      create: vi.fn(async (args: unknown) => {
        record("authSession", "create", args);
        return { id: "session-1" };
      }),
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

  return { client, tx, calls };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-07-13T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

function run(_client: unknown, input: Record<string, unknown>) {
  return withSystemContext("test:sign-in", () =>
    executeSystemCommand(SignIn, { organizationId: ORG_ID, ...input })
  );
}

beforeEach(() => {
  configureAuth(
    buildAuthConfiguration({ clock: clock.createFrozenClock(new Date()), hasher: fakeHasher })
  );
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetAuthConfigurationForTests();
});

describe("SignIn — happy path", () => {
  it("issues a session and audits user.signed_in on a valid password", async () => {
    const fake = buildFake({ user: {}, roleCodes: ["Pharmacist"] });
    configureBus(fake.client);

    const out = await run(fake.client, { email: "op@example.com", password: "correct-password" });

    expect(out.userId).toBe(USER_ID);
    expect(out.sessionId).toBe("session-1");
    expect(out.rawToken).toEqual(expect.any(String));
    expect(out.mfaSatisfied).toBe(true);
    expect(fake.tx.authSession.create).toHaveBeenCalledTimes(1);
    // lastLoginAt stamped.
    expect(fake.tx.user.update).toHaveBeenCalledTimes(1);
    // The bus wrote an audit_log row for user.signed_in.
    expect(fake.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

describe("SignIn — credential rejection (generic, no enumeration)", () => {
  it("throws INVALID_CREDENTIALS for a wrong password", async () => {
    const fake = buildFake({ user: {} });
    configureBus(fake.client);
    await expect(
      run(fake.client, { email: "op@example.com", password: "WRONG" })
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(fake.tx.authSession.create).not.toHaveBeenCalled();
  });

  it("throws INVALID_CREDENTIALS for an unknown user", async () => {
    const fake = buildFake({ user: null });
    configureBus(fake.client);
    await expect(
      run(fake.client, { email: "ghost@example.com", password: "whatever" })
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("throws INVALID_CREDENTIALS for an inactive user", async () => {
    const fake = buildFake({ user: { status: UserStatus.SUSPENDED } });
    configureBus(fake.client);
    await expect(
      run(fake.client, { email: "op@example.com", password: "correct-password" })
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("throws INVALID_CREDENTIALS for a user with no password set", async () => {
    const fake = buildFake({ user: { hashedPassword: null } });
    configureBus(fake.client);
    await expect(
      run(fake.client, { email: "invited@example.com", password: "whatever" })
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });
});

describe("SignIn — MFA floor", () => {
  it("requires enrollment for a floor role with no authenticator", async () => {
    const fake = buildFake({ user: {}, roleCodes: ["OrgAdmin"], enrollment: null });
    configureBus(fake.client);
    await expect(
      run(fake.client, { email: "admin@example.com", password: "correct-password" })
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    expect(fake.tx.authSession.create).not.toHaveBeenCalled();
  });

  it("requires a code when a floor role is enrolled but none is supplied", async () => {
    const fake = buildFake({
      user: { mfaEnrolled: true },
      roleCodes: ["OrgAdmin"],
      enrollment: { id: "enr-1", secretCiphertext: "{}" },
    });
    configureBus(fake.client);
    await expect(
      run(fake.client, { email: "admin@example.com", password: "correct-password" })
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    expect(fake.tx.authSession.create).not.toHaveBeenCalled();
  });
});
