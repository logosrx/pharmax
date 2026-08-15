// ConfirmWebAuthnCredential — challenge-binding contract tests.
//
// The sibling `webauthn.test.ts` pins the storage happy path, the
// first-authenticator recovery-code rule, a failed attestation, an
// already-consumed challenge, and a challenge minted for the wrong
// ceremony. This file covers the rest of the single-use gate, which is
// the part an attacker actually attacks:
//
//   - Replay: completing the same challenge twice.
//   - Ownership: a challenge minted for another operator.
//   - Expiry, at the exact boundary.
//   - Ordering: the challenge is consumed before any signature check.
//   - A prior TOTP factor (not just a prior key) suppresses the
//     recovery-code reset.
//
// The adapter is faked — @simplewebauthn/server owns the cryptography
// and is trusted here, exactly as in the sibling file.

import { afterEach, describe, expect, it, vi } from "vitest";

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
import { ConfirmWebAuthnCredential } from "./confirm-webauthn.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_USER_ID = "00000000-0000-4000-8000-0000000000a2";
const CHALLENGE_ID = "00000000-0000-4000-8000-0000000000c1";
const RECOVERY_CODE_COUNT = 3;
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

const verifyRegistration = vi.fn(async () => ({
  verified: true as const,
  credentialId: "cred-new",
  publicKey: "cGtleQ",
  counter: 0n,
  transports: ["usb"],
  aaguid: "aaguid-1",
}));

function buildAdapter(): WebAuthnAdapter {
  return {
    generateRegistrationOptions: vi.fn(async () => ({
      challenge: "reg-challenge",
      optionsJSON: { challenge: "reg-challenge" },
    })),
    verifyRegistration,
    generateAuthenticationOptions: vi.fn(async () => ({
      challenge: "auth-challenge",
      optionsJSON: { challenge: "auth-challenge" },
    })),
    verifyAuthentication: vi.fn(async () => ({ verified: false as const })),
  };
}

interface ChallengeRow {
  id: string;
  userId: string;
  purpose: "REGISTRATION" | "AUTHENTICATION";
  challenge: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

function challengeRow(overrides: Partial<ChallengeRow> = {}): ChallengeRow {
  return {
    id: CHALLENGE_ID,
    userId: USER_ID,
    purpose: "REGISTRATION",
    challenge: "reg-challenge",
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedAt: null,
    ...overrides,
  };
}

function buildFake(seed: {
  challenge?: ChallengeRow | null;
  credentials?: ReadonlyArray<{ id: string }>;
  totpEnrollment?: { id: string } | null;
}) {
  const challenge = seed.challenge === undefined ? challengeRow() : seed.challenge;
  const tx = {
    user: { update: vi.fn(async (_args: unknown) => ({})) },
    webAuthnCredential: {
      findFirst: vi.fn(async () => (seed.credentials ?? [])[0] ?? null),
      create: vi.fn(async (_args: unknown) => ({ id: "wac-row-1" })),
    },
    mfaEnrollment: { findFirst: vi.fn(async () => seed.totpEnrollment ?? null) },
    recoveryCode: {
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
      create: vi.fn(async (_args: unknown) => ({})),
    },
    webAuthnChallenge: {
      findUnique: vi.fn(async () => (challenge === null ? null : { ...challenge })),
      // Mutates the seeded row the way the real UPDATE would, so a
      // second ceremony in the same test sees a consumed challenge.
      update: vi.fn(async (args: { where: { id: string }; data: { consumedAt: Date } }) => {
        if (challenge !== null && challenge.id === args.where.id) {
          challenge.consumedAt = args.data.consumedAt;
        }
        return {};
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
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

function configure(): void {
  configureAuth(
    buildAuthConfiguration({
      clock: clock.createFrozenClock(NOW),
      hasher: fakeHasher,
      mfa: { recoveryCodeCount: RECOVERY_CODE_COUNT },
      webauthn: { adapter: buildAdapter() },
    })
  );
  configureRbac({ loader: new InMemoryPermissionLoader([]) });
}

function run(idempotencyKey: string) {
  return withTenancyContext(
    buildTenancyContext({
      organizationId: ORG_ID,
      actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    }),
    () =>
      executeCommand(
        ConfirmWebAuthnCredential,
        {
          challengeId: CHALLENGE_ID,
          rpId: "pharmax.test",
          origin: "https://acme.pharmax.test",
          label: "Security Key A",
          response: { id: "cred-new", type: "public-key" },
        },
        { idempotencyKey }
      )
  );
}

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetAuthConfigurationForTests();
  verifyRegistration.mockClear();
});

describe("ConfirmWebAuthnCredential — single-use gate", () => {
  it("refuses a second ceremony that replays a challenge already spent", async () => {
    configure();
    const fake = buildFake({ credentials: [] });
    configureBus(fake.client);

    await run("wa-confirm-1a");
    expect(fake.tx.webAuthnCredential.create).toHaveBeenCalledTimes(1);

    // A captured registration response must not be re-submittable: a
    // second success would enroll an extra authenticator on the
    // account, and that key is a permanent second factor.
    await expect(run("wa-confirm-1b")).rejects.toMatchObject({
      code: "WEBAUTHN_CHALLENGE_INVALID",
    });
    expect(fake.tx.webAuthnCredential.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a challenge minted for a different operator", async () => {
    configure();
    const fake = buildFake({ challenge: challengeRow({ userId: OTHER_USER_ID }) });
    configureBus(fake.client);

    // Without the ownership check, an operator who observes any live
    // challenge id could bind their own authenticator to the account
    // that challenge was minted for.
    await expect(run("wa-confirm-2")).rejects.toMatchObject({
      code: "WEBAUTHN_CHALLENGE_INVALID",
    });
    expect(verifyRegistration).not.toHaveBeenCalled();
    expect(fake.tx.webAuthnCredential.create).not.toHaveBeenCalled();
    expect(fake.tx.user.update).not.toHaveBeenCalled();
  });

  it("refuses a challenge id that was never issued", async () => {
    configure();
    const fake = buildFake({ challenge: null });
    configureBus(fake.client);

    await expect(run("wa-confirm-3")).rejects.toMatchObject({
      code: "WEBAUTHN_CHALLENGE_INVALID",
    });
    expect(verifyRegistration).not.toHaveBeenCalled();
  });

  it("treats a challenge whose expiry equals the current instant as expired", async () => {
    configure();
    const fake = buildFake({ challenge: challengeRow({ expiresAt: NOW }) });
    configureBus(fake.client);

    // The comparison is `expiresAt <= now`, so the boundary itself is
    // closed: the deadline is not a grace period.
    await expect(run("wa-confirm-4")).rejects.toMatchObject({
      code: "WEBAUTHN_CHALLENGE_INVALID",
    });
    expect(fake.tx.webAuthnCredential.create).not.toHaveBeenCalled();
  });

  it("accepts a challenge with a millisecond left", async () => {
    configure();
    const fake = buildFake({
      challenge: challengeRow({ expiresAt: new Date(NOW.getTime() + 1) }),
      credentials: [],
    });
    configureBus(fake.client);

    const out = await run("wa-confirm-5");

    expect(out.credentialRowId).toBe("wac-row-1");
  });

  it("consumes the challenge before running any signature check", async () => {
    configure();
    const fake = buildFake({ credentials: [] });
    configureBus(fake.client);

    await run("wa-confirm-6");

    // Verifying first and consuming afterwards would leave a window in
    // which two concurrent submissions of the same captured response
    // both pass.
    const consumedAt = fake.tx.webAuthnChallenge.update.mock.invocationCallOrder[0]!;
    const verifiedAt = verifyRegistration.mock.invocationCallOrder[0]!;
    expect(consumedAt).toBeLessThan(verifiedAt);
    expect(fake.tx.webAuthnChallenge.update).toHaveBeenCalledWith({
      where: { id: CHALLENGE_ID },
      data: { consumedAt: NOW },
    });
  });
});

describe("ConfirmWebAuthnCredential — enrollment effects", () => {
  it("stores the credential under the caller's organization and audits it", async () => {
    configure();
    const fake = buildFake({ credentials: [] });
    configureBus(fake.client);

    await run("wa-confirm-7");

    // The org stamp comes from the tenancy frame; a credential row
    // filed under the wrong tenant would be invisible to the owning
    // organization's administrators.
    expect(fake.tx.webAuthnCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          userId: USER_ID,
          credentialId: "cred-new",
          createdAt: NOW,
        }),
      })
    );
    expect(fake.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "user.webauthn.credential_enrolled",
          resourceType: "User",
          resourceId: USER_ID,
          organizationId: ORG_ID,
          metadata: expect.objectContaining({ firstAuthenticator: true }),
        }),
      })
    );
    expect(fake.tx.eventOutbox.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ eventType: "user.webauthn.credential_enrolled.v1" })],
      })
    );
  });

  it("does not reset recovery codes when the account already has TOTP", async () => {
    configure();
    const fake = buildFake({ credentials: [], totpEnrollment: { id: "enr-live" } });
    configureBus(fake.client);

    const out = await run("wa-confirm-8");

    // Adding a key to an account that already has a factor must not
    // invalidate the recovery codes its owner already wrote down.
    expect(out.recoveryCodes).toHaveLength(0);
    expect(fake.tx.recoveryCode.deleteMany).not.toHaveBeenCalled();
    expect(fake.tx.recoveryCode.create).not.toHaveBeenCalled();
    expect(fake.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ firstAuthenticator: false }),
        }),
      })
    );
  });

  it("persists first-authenticator recovery codes only as hashes", async () => {
    configure();
    const fake = buildFake({ credentials: [] });
    configureBus(fake.client);

    const out = await run("wa-confirm-9");

    expect(out.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    const rows = fake.tx.recoveryCode.create.mock.calls.map(
      (call) =>
        (call[0] as { data: { organizationId: string; userId: string; codeHash: string } }).data
    );
    for (const [index, row] of rows.entries()) {
      const plaintext = out.recoveryCodes[index]!;
      // A readable code in this column is a standing bypass of both
      // factor types for whoever can read the table.
      expect(row.codeHash).not.toBe(plaintext);
      expect(row.codeHash).toBe(`h:${plaintext.replace(/-/g, "")}`);
      expect(row).toMatchObject({ organizationId: ORG_ID, userId: USER_ID });
    }

    const succeeded = fake.tx.commandLog.update.mock.calls.at(-1)![0] as {
      data: { responsePayload: Record<string, unknown> };
    };
    expect(succeeded.data.responsePayload).toMatchObject({ recoveryCodes: "[Redacted]" });
  });
});
