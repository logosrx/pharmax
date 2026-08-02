// WebAuthn ceremony command tests (bus-integrated, DB-free, ADR-0036).
//
// Pins the engine-side rules with a fake adapter (no CBOR/COSE here —
// @simplewebauthn/server is trusted for the cryptography):
//
//   - EnrollWebAuthnCredential mints a REGISTRATION challenge and
//     excludes already-registered credential ids.
//   - ConfirmWebAuthnCredential consumes the challenge, stores the
//     credential, flips mfaEnrolled, and mints recovery codes ONLY for
//     the account's first authenticator.
//   - StartWebAuthnAuthentication is password-gated, refuses accounts
//     with no active credential, and mints an AUTHENTICATION challenge.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { UserStatus } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  resetRbacConfigurationForTests,
} from "@pharmax/rbac";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";

import {
  buildAuthConfiguration,
  configureAuth,
  resetAuthConfigurationForTests,
} from "../configure.js";
import type { PasswordHasher } from "../password/hasher.js";
import type { WebAuthnAdapter } from "../mfa/webauthn.js";
import { ConfirmWebAuthnCredential } from "./confirm-webauthn.js";
import { EnrollWebAuthnCredential } from "./enroll-webauthn.js";
import { StartWebAuthnAuthentication } from "./start-webauthn-authentication.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const CHALLENGE_ID = "00000000-0000-4000-8000-0000000000c1";
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

function buildAdapter(overrides: Partial<WebAuthnAdapter> = {}): WebAuthnAdapter {
  return {
    generateRegistrationOptions: vi.fn(async () => ({
      challenge: "reg-challenge",
      optionsJSON: { challenge: "reg-challenge" },
    })),
    verifyRegistration: vi.fn(async () => ({
      verified: true as const,
      credentialId: "cred-new",
      publicKey: "cGtleQ",
      counter: 0n,
      transports: ["usb"],
      aaguid: "aaguid-1",
    })),
    generateAuthenticationOptions: vi.fn(async () => ({
      challenge: "auth-challenge",
      optionsJSON: { challenge: "auth-challenge" },
    })),
    verifyAuthentication: vi.fn(async () => ({ verified: true as const, newCounter: 1n })),
    ...overrides,
  };
}

interface FakeSeed {
  readonly credentials?: ReadonlyArray<{ id: string; credentialId: string }>;
  readonly totpEnrollment?: { id: string } | null;
  readonly challenge?: {
    id: string;
    userId: string;
    purpose: "REGISTRATION" | "AUTHENTICATION";
    challenge: string;
    expiresAt: Date;
    consumedAt: Date | null;
  } | null;
  readonly user?: {
    status?: UserStatus;
    hashedPassword?: string | null;
  } | null;
}

function buildFake(seed: FakeSeed = {}) {
  const tx = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({
        email: "op@example.com",
        displayName: "Op Erator",
      })),
      findUnique: vi.fn(async () =>
        seed.user === null
          ? null
          : {
              id: USER_ID,
              status: seed.user?.status ?? UserStatus.ACTIVE,
              hashedPassword:
                seed.user?.hashedPassword === undefined
                  ? "h:correct-password"
                  : seed.user.hashedPassword,
              mfaEnrolled: false,
            }
      ),
      update: vi.fn(async () => ({})),
    },
    webAuthnCredential: {
      findMany: vi.fn(async () =>
        (seed.credentials ?? []).map((c) => ({ ...c, transports: ["usb"] }))
      ),
      findFirst: vi.fn(async () => (seed.credentials ?? [])[0] ?? null),
      create: vi.fn(async (_args: unknown) => ({ id: "wac-row-1" })),
    },
    mfaEnrollment: {
      findFirst: vi.fn(async () => seed.totpEnrollment ?? null),
    },
    recoveryCode: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({})),
    },
    webAuthnChallenge: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async (_args: unknown) => ({ id: CHALLENGE_ID })),
      findUnique: vi.fn(async () => seed.challenge ?? null),
      update: vi.fn(async (_args: unknown) => ({})),
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
    clock: clock.createFrozenClock(NOW),
    logger: logger.noopLogger,
  });
}

function configure(adapter: WebAuthnAdapter): void {
  configureAuth(
    buildAuthConfiguration({
      clock: clock.createFrozenClock(NOW),
      hasher: fakeHasher,
      mfa: { recoveryCodeCount: 3 },
      webauthn: { adapter },
    })
  );
  configureRbac({ loader: new InMemoryPermissionLoader([]) });
}

function tenantCtx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetAuthConfigurationForTests();
});

describe("EnrollWebAuthnCredential", () => {
  it("mints a REGISTRATION challenge and returns creation options", async () => {
    const adapter = buildAdapter();
    configure(adapter);
    const fake = buildFake({ credentials: [{ id: "row-1", credentialId: "cred-existing" }] });
    configureBus(fake.client);

    const out = await withTenancyContext(tenantCtx(), () =>
      executeCommand(EnrollWebAuthnCredential, { rpId: "pharmax.test" }, { idempotencyKey: "e1" })
    );

    expect(out.challengeId).toBe(CHALLENGE_ID);
    expect(out.optionsJSON).toEqual({ challenge: "reg-challenge" });
    // Existing credentials are excluded so the same key can't re-register.
    expect(adapter.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ excludeCredentialIds: ["cred-existing"] })
    );
    expect(fake.tx.webAuthnChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ purpose: "REGISTRATION", challenge: "reg-challenge" }),
      })
    );
  });
});

describe("ConfirmWebAuthnCredential", () => {
  const validChallenge = {
    id: CHALLENGE_ID,
    userId: USER_ID,
    purpose: "REGISTRATION" as const,
    challenge: "reg-challenge",
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedAt: null,
  };

  function confirmInput() {
    return {
      challengeId: CHALLENGE_ID,
      rpId: "pharmax.test",
      origin: "https://acme.pharmax.test",
      label: "YubiKey 5C",
      response: { id: "cred-new", type: "public-key" },
    };
  }

  it("stores the credential, flips mfaEnrolled, and mints recovery codes for a first authenticator", async () => {
    const adapter = buildAdapter();
    configure(adapter);
    const fake = buildFake({ challenge: validChallenge, credentials: [], totpEnrollment: null });
    configureBus(fake.client);

    const out = await withTenancyContext(tenantCtx(), () =>
      executeCommand(ConfirmWebAuthnCredential, confirmInput(), { idempotencyKey: "c1" })
    );

    expect(out.credentialRowId).toBe("wac-row-1");
    expect(out.recoveryCodes).toHaveLength(3);
    expect(fake.tx.webAuthnCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          credentialId: "cred-new",
          publicKey: "cGtleQ",
          label: "YubiKey 5C",
        }),
      })
    );
    expect(fake.tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { mfaEnrolled: true } })
    );
    // Challenge consumed in the same tx.
    expect(fake.tx.webAuthnChallenge.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CHALLENGE_ID } })
    );
  });

  it("does NOT mint recovery codes when another authenticator already exists", async () => {
    const adapter = buildAdapter();
    configure(adapter);
    const fake = buildFake({
      challenge: validChallenge,
      credentials: [{ id: "row-1", credentialId: "cred-existing" }],
    });
    configureBus(fake.client);

    const out = await withTenancyContext(tenantCtx(), () =>
      executeCommand(ConfirmWebAuthnCredential, confirmInput(), { idempotencyKey: "c2" })
    );

    expect(out.recoveryCodes).toHaveLength(0);
    expect(fake.tx.recoveryCode.create).not.toHaveBeenCalled();
    expect(fake.tx.recoveryCode.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a failed attestation without storing anything", async () => {
    const adapter = buildAdapter({
      verifyRegistration: vi.fn(async () => ({ verified: false as const })),
    });
    configure(adapter);
    const fake = buildFake({ challenge: validChallenge });
    configureBus(fake.client);

    await expect(
      withTenancyContext(tenantCtx(), () =>
        executeCommand(ConfirmWebAuthnCredential, confirmInput(), { idempotencyKey: "c3" })
      )
    ).rejects.toMatchObject({ code: "WEBAUTHN_REGISTRATION_FAILED" });
    expect(fake.tx.webAuthnCredential.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown or already-consumed challenge", async () => {
    const adapter = buildAdapter();
    configure(adapter);
    const fake = buildFake({
      challenge: { ...validChallenge, consumedAt: new Date(NOW.getTime() - 1000) },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(tenantCtx(), () =>
        executeCommand(ConfirmWebAuthnCredential, confirmInput(), { idempotencyKey: "c4" })
      )
    ).rejects.toMatchObject({ code: "WEBAUTHN_CHALLENGE_INVALID" });
    expect(adapter.verifyRegistration).not.toHaveBeenCalled();
  });

  it("rejects a challenge minted for the AUTHENTICATION ceremony", async () => {
    const adapter = buildAdapter();
    configure(adapter);
    const fake = buildFake({
      challenge: { ...validChallenge, purpose: "AUTHENTICATION" as const },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(tenantCtx(), () =>
        executeCommand(ConfirmWebAuthnCredential, confirmInput(), { idempotencyKey: "c5" })
      )
    ).rejects.toMatchObject({ code: "WEBAUTHN_CHALLENGE_INVALID" });
  });
});

describe("StartWebAuthnAuthentication", () => {
  function startInput() {
    return {
      organizationId: ORG_ID,
      email: "op@example.com",
      password: "correct-password",
      rpId: "pharmax.test",
    };
  }

  function runStart(input: Record<string, unknown>) {
    return withSystemContext("test:webauthn-start", () =>
      executeSystemCommand(StartWebAuthnAuthentication, { ...startInput(), ...input })
    );
  }

  it("mints an AUTHENTICATION challenge with the user's credentials allowed", async () => {
    const adapter = buildAdapter();
    configure(adapter);
    const fake = buildFake({
      user: {},
      credentials: [{ id: "row-1", credentialId: "cred-abc" }],
    });
    configureBus(fake.client);

    const out = await runStart({});

    expect(out.userId).toBe(USER_ID);
    expect(out.challengeId).toBe(CHALLENGE_ID);
    expect(out.optionsJSON).toEqual({ challenge: "auth-challenge" });
    expect(adapter.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        allowCredentials: [{ credentialId: "cred-abc", transports: ["usb"] }],
      })
    );
    expect(fake.tx.webAuthnChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ purpose: "AUTHENTICATION" }),
      })
    );
  });

  it("is password-gated: wrong password never reaches credential lookup", async () => {
    const adapter = buildAdapter();
    configure(adapter);
    const fake = buildFake({
      user: {},
      credentials: [{ id: "row-1", credentialId: "cred-abc" }],
    });
    configureBus(fake.client);

    await expect(runStart({ password: "WRONG" })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(fake.tx.webAuthnCredential.findMany).not.toHaveBeenCalled();
    expect(fake.tx.webAuthnChallenge.create).not.toHaveBeenCalled();
  });

  it("refuses an account with no active credential", async () => {
    const adapter = buildAdapter();
    configure(adapter);
    const fake = buildFake({ user: {}, credentials: [] });
    configureBus(fake.client);

    await expect(runStart({})).rejects.toMatchObject({ code: "WEBAUTHN_NOT_ENROLLED" });
    expect(fake.tx.webAuthnChallenge.create).not.toHaveBeenCalled();
  });

  it("rejects an inactive user with the generic credential error", async () => {
    const adapter = buildAdapter();
    configure(adapter);
    const fake = buildFake({
      user: { status: UserStatus.SUSPENDED },
      credentials: [{ id: "row-1", credentialId: "cred-abc" }],
    });
    configureBus(fake.client);

    await expect(runStart({})).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });
});
