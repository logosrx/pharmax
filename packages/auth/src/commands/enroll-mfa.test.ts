// EnrollMfa contract tests (bus-integrated, DB-free).
//
// This is the command where a TOTP shared secret comes into existence,
// so the properties pinned here are the ones whose regression is
// silent rather than loud:
//
//   - The secret reaches the database SEALED, bound to (organization,
//     user), and round-trips only under that exact binding.
//   - Neither the secret nor the provisioning URI reaches command_log,
//     audit_log, or the outbox.
//   - An account with a live authenticator cannot mint a second one
//     behind it; a half-finished attempt is replaced, a verified one
//     never is.
//
// The real LocalKmsAdapter is wired (not a stub) so the envelope and
// AAD code paths execute for real — a fake cipher would let a binding
// regression through.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureCrypto,
  LocalKmsAdapter,
  resetCryptoConfigurationForTests,
} from "@pharmax/crypto";
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
import { openTotpSecret } from "../mfa/secret-seal.js";
import type { PasswordHasher } from "../password/hasher.js";
import { EnrollMfa } from "./enroll-mfa.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_USER_ID = "00000000-0000-4000-8000-0000000000a2";
const ENROLLMENT_ID = "00000000-0000-4000-8000-0000000000e1";
const OPERATOR_EMAIL = "operator@example.com";
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

function buildFake(seed: { activeEnrollment?: { id: string } | null } = {}) {
  const tx = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({ email: OPERATOR_EMAIL })),
    },
    mfaEnrollment: {
      findFirst: vi.fn(async () => seed.activeEnrollment ?? null),
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
      create: vi.fn(async (_args: unknown) => ({ id: ENROLLMENT_ID })),
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

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function run(idempotencyKey: string) {
  return withTenancyContext(ctx(), () => executeCommand(EnrollMfa, {}, { idempotencyKey }));
}

/** BigInt-safe serialization — audit rows carry a `seq` bigint. */
function serializeCalls(calls: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return JSON.stringify(calls, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value
  );
}

function createdEnrollment(fake: ReturnType<typeof buildFake>) {
  return fake.tx.mfaEnrollment.create.mock.calls[0]![0] as {
    data: { organizationId: string; userId: string; secretCiphertext: string; createdAt: Date };
  };
}

beforeEach(() => {
  configureAuth(
    buildAuthConfiguration({
      clock: clock.createFrozenClock(NOW),
      hasher: fakeHasher,
      mfa: { issuer: "PharmaxTest" },
    })
  );
  configureRbac({ loader: new InMemoryPermissionLoader([]) });
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "enroll-mfa-test-seed" }) });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetAuthConfigurationForTests();
  resetCryptoConfigurationForTests();
});

describe("EnrollMfa", () => {
  it("stores the shared secret sealed, and returns the plaintext only to the caller", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run("enroll-1");

    expect(out.enrollmentId).toBe(ENROLLMENT_ID);
    const stored = createdEnrollment(fake).data.secretCiphertext;
    // A plaintext secret on this column is a permanent second-factor
    // bypass for anyone with read access to the row.
    expect(stored).not.toContain(out.secretBase32);
    expect(JSON.parse(stored)).toMatchObject({ alg: "AES-256-GCM" });
    await expect(
      openTotpSecret({ ciphertext: stored, organizationId: ORG_ID, userId: USER_ID })
    ).resolves.toBe(out.secretBase32);
  });

  it("binds the sealed secret to one (organization, user) pair", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run("enroll-2");
    const stored = createdEnrollment(fake).data.secretCiphertext;
    expect(out.secretBase32.length).toBeGreaterThan(0);

    // Without the binding, a stolen ciphertext could be pasted onto
    // another user's enrollment row and would still open — the thief's
    // authenticator would then satisfy that user's second factor.
    await expect(
      openTotpSecret({ ciphertext: stored, organizationId: ORG_ID, userId: OTHER_USER_ID })
    ).rejects.toMatchObject({ code: "AAD_MISMATCH" });
    await expect(
      openTotpSecret({ ciphertext: stored, organizationId: OTHER_ORG_ID, userId: USER_ID })
    ).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });
  });

  it("scopes the enrollment row to the caller's tenancy, which the input cannot influence", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    await run("enroll-3");

    // EnrollMfa takes an empty input by design: org and user come from
    // the tenancy frame, so no caller can enroll an authenticator onto
    // somebody else's account.
    expect(createdEnrollment(fake).data).toMatchObject({
      organizationId: ORG_ID,
      userId: USER_ID,
      createdAt: NOW,
    });
  });

  it("returns a provisioning URI carrying the configured issuer and the account it belongs to", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run("enroll-4");

    expect(out.otpauthUri).toContain(`secret=${out.secretBase32}`);
    expect(out.otpauthUri).toContain("issuer=PharmaxTest");
    // The account name is what lets an operator tell two enrolled
    // accounts apart in their authenticator app.
    expect(out.otpauthUri).toContain(encodeURIComponent(OPERATOR_EMAIL));
  });

  it("refuses to enroll while an active authenticator already exists", async () => {
    const fake = buildFake({ activeEnrollment: { id: "enr-live" } });
    configureBus(fake.client);

    await expect(run("enroll-5")).rejects.toMatchObject({ code: "MFA_ALREADY_ENROLLED" });
    // Silently minting a second secret would let an attacker who has a
    // live session replace the victim's factor with their own.
    expect(fake.tx.mfaEnrollment.create).not.toHaveBeenCalled();
    expect(fake.tx.mfaEnrollment.deleteMany).not.toHaveBeenCalled();
  });

  it("clears only the unverified attempts when restarting enrollment", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    await run("enroll-6");

    // Widening this filter would delete the account's ACTIVE
    // enrollment, downgrading a protected account to single-factor.
    expect(fake.tx.mfaEnrollment.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, verifiedAt: null },
    });
  });

  it("audits the enrollment start without writing the secret anywhere", async () => {
    const fake = buildFake();
    configureBus(fake.client);

    const out = await run("enroll-7");

    expect(fake.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "user.mfa.enrollment_started",
          resourceType: "User",
          resourceId: USER_ID,
          organizationId: ORG_ID,
        }),
      })
    );
    expect(fake.tx.eventOutbox.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ eventType: "user.mfa.enrollment_started.v1" })],
      })
    );

    // Every row this command writes outside the sealed column is
    // readable by operators and by log shipping. The secret and the
    // URI that embeds it must appear in none of them.
    const persisted = serializeCalls([
      ...fake.tx.auditLog.create.mock.calls,
      ...fake.tx.eventOutbox.createMany.mock.calls,
      ...fake.tx.commandLog.create.mock.calls,
      ...fake.tx.commandLog.update.mock.calls,
      ...fake.tx.idempotencyKey.create.mock.calls,
    ]);
    expect(persisted).not.toContain(out.secretBase32);
    expect(persisted).not.toContain(out.otpauthUri);

    const succeeded = fake.tx.commandLog.update.mock.calls.at(-1)![0] as {
      data: { responsePayload: Record<string, unknown> };
    };
    expect(succeeded.data.responsePayload).toMatchObject({
      otpauthUri: "[Redacted]",
      secretBase32: "[Redacted]",
    });
  });
});
