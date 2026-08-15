// EnrollWebAuthnCredential — challenge-minting contract tests.
//
// The sibling `webauthn.test.ts` already pins the ceremony happy path
// (options returned, already-registered keys excluded). This file
// covers the properties of the minted challenge row itself, which is
// the piece `ConfirmWebAuthnCredential` later trusts:
//
//   - It is stamped with the caller's own organization and user, both
//     taken from the tenancy frame rather than the request.
//   - It expires on the configured TTL, not on an ambient default.
//   - The opportunistic purge that runs at mint time is scoped to this
//     user and this ceremony.
//   - The registration start is audited, and the options blob (which
//     embeds the challenge) never lands in command_log.

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
import type { WebAuthnAdapter } from "../mfa/webauthn.js";
import type { PasswordHasher } from "../password/hasher.js";
import { EnrollWebAuthnCredential } from "./enroll-webauthn.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const CHALLENGE_ID = "00000000-0000-4000-8000-0000000000c1";
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
      optionsJSON: { challenge: "reg-challenge", rp: { id: "pharmax.test" } },
    })),
    verifyRegistration: vi.fn(async () => ({ verified: false as const })),
    generateAuthenticationOptions: vi.fn(async () => ({
      challenge: "auth-challenge",
      optionsJSON: { challenge: "auth-challenge" },
    })),
    verifyAuthentication: vi.fn(async () => ({ verified: false as const })),
  };
}

function buildFake(seed: { credentials?: ReadonlyArray<{ credentialId: string }> } = {}) {
  const tx = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({
        email: "operator@example.com",
        displayName: "Op Erator",
      })),
    },
    webAuthnCredential: {
      findMany: vi.fn(async (_args: unknown) => seed.credentials ?? []),
    },
    webAuthnChallenge: {
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
      create: vi.fn(async (_args: unknown) => ({ id: CHALLENGE_ID })),
    },
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
    idempotencyKey: {
      create: vi.fn(async (_args: unknown) => ({})),
      findUnique: vi.fn(async () => null),
    },
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
      webauthn: { adapter, challengeTtlMs: CHALLENGE_TTL_MS, rpName: "Pharmax Test" },
    })
  );
  configureRbac({ loader: new InMemoryPermissionLoader([]) });
}

function run(idempotencyKey: string, rpId = "pharmax.test") {
  return withTenancyContext(
    buildTenancyContext({
      organizationId: ORG_ID,
      actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    }),
    () => executeCommand(EnrollWebAuthnCredential, { rpId }, { idempotencyKey })
  );
}

function mintedChallenge(fake: ReturnType<typeof buildFake>) {
  return fake.tx.webAuthnChallenge.create.mock.calls[0]![0] as {
    data: {
      organizationId: string;
      userId: string;
      purpose: string;
      challenge: string;
      expiresAt: Date;
      createdAt: Date;
    };
  };
}

beforeEach(() => {
  configure(buildAdapter());
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetAuthConfigurationForTests();
});

describe("EnrollWebAuthnCredential", () => {
  it("binds the challenge to the caller's own organization and user", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    await run("wa-enroll-1");

    // The request carries only an rpId, so a caller cannot mint a
    // registration challenge against another account or tenant.
    expect(mintedChallenge(fake).data).toMatchObject({
      organizationId: ORG_ID,
      userId: USER_ID,
      purpose: "REGISTRATION",
      challenge: "reg-challenge",
      createdAt: NOW,
    });
  });

  it("expires the challenge on the configured TTL", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    await run("wa-enroll-2");

    // A challenge that outlives its window is a credential-injection
    // opportunity for anyone who captures the ceremony options.
    expect(mintedChallenge(fake).data.expiresAt).toEqual(
      new Date(NOW.getTime() + CHALLENGE_TTL_MS)
    );
  });

  it("purges only this user's own expired registration challenges", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    await run("wa-enroll-3");

    // Losing any of these three filters turns routine housekeeping
    // into a denial of service against other operators' in-flight
    // ceremonies.
    expect(fake.tx.webAuthnChallenge.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, purpose: "REGISTRATION", expiresAt: { lt: NOW } },
    });
  });

  it("excludes nothing when the account has no credential yet", async () => {
    const adapter = buildAdapter();
    configure(adapter);
    const fake = buildFake({ credentials: [] });
    configureBus(fake.client);

    await run("wa-enroll-4");

    expect(adapter.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ excludeCredentialIds: [] })
    );
  });

  it("passes the web tier's relying-party id through and names the RP from configuration", async () => {
    const adapter = buildAdapter();
    configure(adapter);
    const fake = buildFake();
    configureBus(fake.client);

    await run("wa-enroll-5", "acme.pharmax.test");

    // rpId is resolved server-side from the trusted host, never taken
    // from the browser — a browser-supplied value would let a hostile
    // origin scope a credential to itself.
    expect(adapter.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpId: "acme.pharmax.test",
        rpName: "Pharmax Test",
        userId: USER_ID,
      })
    );
  });

  it("audits the registration start and keeps the options out of the command log", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    await run("wa-enroll-6");

    expect(fake.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "user.webauthn.registration_started",
          resourceType: "User",
          resourceId: USER_ID,
          organizationId: ORG_ID,
          metadata: expect.objectContaining({ challengeId: CHALLENGE_ID }),
        }),
      })
    );
    expect(fake.tx.eventOutbox.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ eventType: "user.webauthn.registration_started.v1" })],
      })
    );

    // The options blob embeds the challenge; logging it verbatim would
    // hand a log reader a ceremony they could try to complete.
    const succeeded = fake.tx.commandLog.update.mock.calls.at(-1)![0] as {
      data: { responsePayload: Record<string, unknown> };
    };
    expect(succeeded.data.responsePayload).toMatchObject({ optionsJSON: "[Redacted]" });
  });
});
