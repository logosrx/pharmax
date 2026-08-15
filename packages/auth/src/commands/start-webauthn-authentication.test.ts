// StartWebAuthnAuthentication — pre-session assertion-challenge tests.
//
// The sibling `webauthn.test.ts` pins the happy path, the password
// gate, the not-enrolled refusal, and the inactive-account refusal.
// This file covers the remaining pre-auth exposure of an endpoint that
// anyone on the internet can call:
//
//   - Every rejection is the same opaque INVALID_CREDENTIALS, so the
//     endpoint cannot be used to test whether an address has an
//     account (or a password) in a given organization.
//   - The account lookup is scoped to the requested organization.
//   - The minted challenge belongs to the authenticated user and the
//     requested organization, and expires on the configured TTL.
//   - No session is ever minted here — this endpoint hands out
//     ceremony options, not access.

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
import type { WebAuthnAdapter } from "../mfa/webauthn.js";
import type { PasswordHasher } from "../password/hasher.js";
import { StartWebAuthnAuthentication } from "./start-webauthn-authentication.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const CHALLENGE_ID = "00000000-0000-4000-8000-0000000000c1";
const ACCOUNT_EMAIL = "operator@example.com";
const PASSWORD = "correct-horse-staple-9";
const CHALLENGE_TTL_MS = 90_000;
const NOW = new Date("2026-08-01T12:00:00.000Z");

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

function buildAdapter(): WebAuthnAdapter {
  return {
    generateRegistrationOptions: vi.fn(async () => ({
      challenge: "reg-challenge",
      optionsJSON: { challenge: "reg-challenge" },
    })),
    verifyRegistration: vi.fn(async () => ({ verified: false as const })),
    generateAuthenticationOptions: vi.fn(async () => ({
      challenge: "auth-challenge",
      optionsJSON: { challenge: "auth-challenge" },
    })),
    verifyAuthentication: vi.fn(async () => ({ verified: false as const })),
  };
}

interface UserSeed {
  readonly status?: UserStatus;
  readonly hashedPassword?: string | null;
}

function buildFake(seed: {
  user?: UserSeed | null;
  credentials?: ReadonlyArray<{ credentialId: string; transports: ReadonlyArray<string> }>;
}) {
  const tx = {
    user: {
      // Resolves strictly on the (organization, email) unique key the
      // handler asks for, so a lookup outside that pair genuinely
      // misses rather than being waved through by the fake.
      findUnique: vi.fn(
        async (args: {
          where: { organizationId_email: { organizationId: string; email: string } };
        }) => {
          const key = args.where.organizationId_email;
          if (seed.user === null) return null;
          if (key.organizationId !== ORG_ID || key.email !== ACCOUNT_EMAIL) return null;
          return {
            id: USER_ID,
            status: seed.user?.status ?? UserStatus.ACTIVE,
            hashedPassword:
              seed.user?.hashedPassword === undefined ? `h:${PASSWORD}` : seed.user.hashedPassword,
            mfaEnrolled: true,
          };
        }
      ),
    },
    webAuthnCredential: {
      findMany: vi.fn(async (_args: unknown) =>
        (seed.credentials ?? [{ credentialId: "cred-abc", transports: ["usb"] }]).map((c) => ({
          ...c,
          transports: [...c.transports],
        }))
      ),
    },
    webAuthnChallenge: {
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
      create: vi.fn(async (_args: unknown) => ({ id: CHALLENGE_ID })),
    },
    authSession: { create: vi.fn(async (_args: unknown) => ({ id: "session-1" })) },
    commandLog: {
      create: vi.fn(async (_args: unknown) => ({ id: "cl-1" })),
      update: vi.fn(async (_args: unknown) => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: { create: vi.fn(async (_args: unknown) => ({ id: "al-1" })) },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        organizationId: ORG_ID,
        latestHash: Buffer.alloc(32),
        latestSeq: 1n,
      })),
    },
    eventOutbox: { createMany: vi.fn(async (_args: unknown) => ({ count: 1 })) },
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

function run(overrides: Record<string, unknown> = {}) {
  return withSystemContext("test:webauthn-start", () =>
    executeSystemCommand(StartWebAuthnAuthentication, {
      organizationId: ORG_ID,
      email: ACCOUNT_EMAIL,
      password: PASSWORD,
      rpId: "pharmax.test",
      ...overrides,
    })
  );
}

function mintedChallenge(fake: ReturnType<typeof buildFake>) {
  return fake.tx.webAuthnChallenge.create.mock.calls[0]![0] as {
    data: { organizationId: string; userId: string; purpose: string; expiresAt: Date };
  };
}

beforeEach(() => {
  configureAuth(
    buildAuthConfiguration({
      clock: clock.createFrozenClock(NOW),
      hasher: fakeHasher,
      webauthn: { adapter: buildAdapter(), challengeTtlMs: CHALLENGE_TTL_MS },
    })
  );
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetAuthConfigurationForTests();
});

describe("StartWebAuthnAuthentication — enumeration defence", () => {
  it("gives an unknown address the same answer as a wrong password", async () => {
    const fake = buildFake({ user: null });
    configureBus(fake.client);

    // This endpoint is reachable pre-session. A distinguishable
    // response would turn it into an account-existence oracle for any
    // address in a known organization.
    await expect(run({ email: "nobody@example.com" })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(fake.tx.webAuthnCredential.findMany).not.toHaveBeenCalled();
    expect(fake.tx.webAuthnChallenge.create).not.toHaveBeenCalled();
  });

  it("refuses an account that has never set a password", async () => {
    const fake = buildFake({ user: { hashedPassword: null } });
    configureBus(fake.client);

    // An invited-but-not-activated account has no first factor, so it
    // must not be able to skip straight to the second one.
    await expect(run()).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(fake.tx.webAuthnChallenge.create).not.toHaveBeenCalled();
  });

  it("does not resolve an account through a different organization", async () => {
    const fake = buildFake({ user: {} });
    configureBus(fake.client);

    // Same address, same password, other tenant: cross-tenant reuse of
    // an account is a critical isolation failure, so the lookup key
    // must carry the organization.
    await expect(run({ organizationId: OTHER_ORG_ID })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(fake.tx.webAuthnChallenge.create).not.toHaveBeenCalled();
  });

  it("normalizes the address before the lookup", async () => {
    const fake = buildFake({ user: {} });
    configureBus(fake.client);

    const out = await run({ email: "Operator@Example.COM" });

    // Addresses are stored lowercased; skipping normalization would
    // make a correct password look wrong depending on how the operator
    // typed their address.
    expect(out.userId).toBe(USER_ID);
  });
});

describe("StartWebAuthnAuthentication — challenge issuance", () => {
  it("binds the challenge to the verified user and the requested organization", async () => {
    const fake = buildFake({ user: {} });
    configureBus(fake.client);

    const out = await run();

    expect(out.challengeId).toBe(CHALLENGE_ID);
    // userId comes from the verified first factor, never from the
    // request, so a caller cannot mint an assertion challenge for an
    // account whose password they do not hold.
    expect(mintedChallenge(fake).data).toMatchObject({
      organizationId: ORG_ID,
      userId: USER_ID,
      purpose: "AUTHENTICATION",
    });
    expect(mintedChallenge(fake).data.expiresAt).toEqual(
      new Date(NOW.getTime() + CHALLENGE_TTL_MS)
    );
  });

  it("never mints a session", async () => {
    const fake = buildFake({ user: {} });
    configureBus(fake.client);

    await run();

    // The assertion is verified by SignIn, which is where a session is
    // issued. If this command ever created one, the WebAuthn ceremony
    // would be decorative.
    expect(fake.tx.authSession.create).not.toHaveBeenCalled();
  });

  it("audits the ceremony start and redacts the password and options", async () => {
    const fake = buildFake({
      user: {},
      credentials: [
        { credentialId: "cred-abc", transports: ["usb"] },
        { credentialId: "cred-def", transports: ["internal"] },
      ],
    });
    configureBus(fake.client);

    await run();

    expect(fake.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "user.webauthn.authentication_started",
          resourceType: "User",
          resourceId: USER_ID,
          organizationId: ORG_ID,
          metadata: expect.objectContaining({ challengeId: CHALLENGE_ID, credentialCount: 2 }),
        }),
      })
    );

    const requested = fake.tx.commandLog.create.mock.calls[0]![0] as {
      data: { requestPayload: Record<string, unknown> };
    };
    expect(requested.data.requestPayload).toMatchObject({ password: "[Redacted]" });
    expect(requested.data.requestPayload).not.toMatchObject({ password: PASSWORD });

    const succeeded = fake.tx.commandLog.update.mock.calls.at(-1)![0] as {
      data: { responsePayload: Record<string, unknown> };
    };
    expect(succeeded.data.responsePayload).toMatchObject({ optionsJSON: "[Redacted]" });
  });
});
