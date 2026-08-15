// ConfirmMfa contract tests (bus-integrated, DB-free).
//
// ConfirmMfa is the step that turns a pending TOTP enrollment into an
// active second factor, so a regression here is an authentication
// bypass rather than a bug. Pinned:
//
//   - A code that does not verify activates nothing.
//   - Only a PENDING enrollment is confirmable; an already-verified
//     one is not re-confirmable (the TOTP analogue of challenge
//     replay).
//   - The sealed secret only opens under the enrolling (organization,
//     user) — a row lifted from another tenant or another operator
//     refuses to open and nothing is activated.
//   - Recovery codes are returned once and persisted only as hashes,
//     and the previous unused set is invalidated.
//
// Real crypto (LocalKmsAdapter) and the real `otpauth` primitives are
// used; only Prisma and the password hasher are faked.

import { Secret, TOTP } from "otpauth";
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
import { sealTotpSecret } from "../mfa/secret-seal.js";
import { generateTotpSecretBase32 } from "../mfa/totp.js";
import type { PasswordHasher } from "../password/hasher.js";
import { ConfirmMfa } from "./confirm-mfa.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_USER_ID = "00000000-0000-4000-8000-0000000000a2";
const ENROLLMENT_ID = "00000000-0000-4000-8000-0000000000e1";
const RECOVERY_CODE_COUNT = 4;
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

function totpFor(secretBase32: string): TOTP {
  return new TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

/**
 * A six-digit code that is NOT accepted for `secretBase32` anywhere in
 * the ±1-period drift window. Computed rather than hard-coded so the
 * "wrong code" tests can never accidentally submit a valid one.
 */
function invalidTotpCode(secretBase32: string): string {
  const totp = totpFor(secretBase32);
  const at = Date.now();
  const accepted = new Set(
    [-30_000, 0, 30_000].map((offset) => totp.generate({ timestamp: at + offset }))
  );
  for (let i = 0; i < accepted.size + 1; i += 1) {
    const candidate = String(i).padStart(6, "0");
    if (!accepted.has(candidate)) return candidate;
  }
  throw new Error("unreachable: more colliding codes than candidates");
}

interface EnrollmentSeed {
  readonly id: string;
  readonly secretCiphertext: string;
  readonly verifiedAt: Date | null;
}

function buildFake(seed: { enrollment?: EnrollmentSeed | null } = {}) {
  const enrollment = seed.enrollment ?? null;
  const tx = {
    user: { update: vi.fn(async (_args: unknown) => ({})) },
    mfaEnrollment: {
      // Honours the handler's `verifiedAt: null` filter so an already
      // active enrollment is genuinely invisible to ConfirmMfa.
      findFirst: vi.fn(async (args: { where: { verifiedAt: Date | null } }) => {
        if (enrollment === null) return null;
        if (args.where.verifiedAt === null && enrollment.verifiedAt !== null) return null;
        return { id: enrollment.id, secretCiphertext: enrollment.secretCiphertext };
      }),
      update: vi.fn(async (_args: unknown) => ({})),
    },
    recoveryCode: {
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
      create: vi.fn(async (_args: unknown) => ({})),
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

function ctx(organizationId: string = ORG_ID) {
  return buildTenancyContext({
    organizationId,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function run(input: { code: string; idempotencyKey: string; organizationId?: string }) {
  return withTenancyContext(ctx(input.organizationId ?? ORG_ID), () =>
    executeCommand(ConfirmMfa, { code: input.code }, { idempotencyKey: input.idempotencyKey })
  );
}

/** BigInt-safe serialization — audit rows carry a `seq` bigint. */
function serializeCalls(calls: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return JSON.stringify(calls, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value
  );
}

async function pendingEnrollment(
  overrides: { organizationId?: string; userId?: string } = {}
): Promise<EnrollmentSeed & { secretBase32: string }> {
  const secretBase32 = generateTotpSecretBase32();
  return {
    id: ENROLLMENT_ID,
    verifiedAt: null,
    secretBase32,
    secretCiphertext: await sealTotpSecret({
      secretBase32,
      organizationId: overrides.organizationId ?? ORG_ID,
      userId: overrides.userId ?? USER_ID,
    }),
  };
}

beforeEach(() => {
  configureAuth(
    buildAuthConfiguration({
      clock: clock.createFrozenClock(NOW),
      hasher: fakeHasher,
      mfa: { recoveryCodeCount: RECOVERY_CODE_COUNT },
    })
  );
  configureRbac({ loader: new InMemoryPermissionLoader([]) });
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "confirm-mfa-test-seed" }) });
});
afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetAuthConfigurationForTests();
  resetCryptoConfigurationForTests();
});

describe("ConfirmMfa", () => {
  it("activates the enrollment and issues recovery codes for a valid code", async () => {
    const seed = await pendingEnrollment();
    const fake = buildFake({ enrollment: seed });
    configureBus(fake.client);

    const out = await run({
      code: totpFor(seed.secretBase32).generate(),
      idempotencyKey: "confirm-1",
    });

    expect(out.enrollmentId).toBe(ENROLLMENT_ID);
    expect(out.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(fake.tx.mfaEnrollment.update).toHaveBeenCalledWith({
      where: { id: ENROLLMENT_ID },
      data: { verifiedAt: NOW },
    });
    expect(fake.tx.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { mfaEnrolled: true },
    });
    expect(fake.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "user.mfa.enrolled",
          resourceId: USER_ID,
          organizationId: ORG_ID,
        }),
      })
    );
  });

  it("accepts a code typed with spaces", async () => {
    const seed = await pendingEnrollment();
    const fake = buildFake({ enrollment: seed });
    configureBus(fake.client);

    const code = totpFor(seed.secretBase32).generate();
    const out = await run({
      code: `${code.slice(0, 3)} ${code.slice(3)}`,
      idempotencyKey: "confirm-2",
    });

    expect(out.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
  });

  it("activates nothing when the code does not verify", async () => {
    const seed = await pendingEnrollment();
    const fake = buildFake({ enrollment: seed });
    configureBus(fake.client);

    await expect(
      run({ code: invalidTotpCode(seed.secretBase32), idempotencyKey: "confirm-3" })
    ).rejects.toMatchObject({ code: "MFA_INVALID" });

    // If any of these ran before the code check, possession of the
    // enrollment row alone would be enough to satisfy the factor.
    expect(fake.tx.mfaEnrollment.update).not.toHaveBeenCalled();
    expect(fake.tx.user.update).not.toHaveBeenCalled();
    expect(fake.tx.recoveryCode.create).not.toHaveBeenCalled();
  });

  it("rejects a code that is not six digits without touching the secret", async () => {
    const seed = await pendingEnrollment();
    const fake = buildFake({ enrollment: seed });
    configureBus(fake.client);

    await expect(run({ code: "12345", idempotencyKey: "confirm-4" })).rejects.toMatchObject({
      code: "MFA_INVALID",
    });
    expect(fake.tx.user.update).not.toHaveBeenCalled();
  });

  it("refuses when there is no pending enrollment", async () => {
    const fake = buildFake({ enrollment: null });
    configureBus(fake.client);

    await expect(run({ code: "123456", idempotencyKey: "confirm-5" })).rejects.toMatchObject({
      code: "MFA_NO_PENDING_ENROLLMENT",
    });
    expect(fake.tx.user.update).not.toHaveBeenCalled();
  });

  it("cannot re-confirm an enrollment that is already verified", async () => {
    const seed = await pendingEnrollment();
    const fake = buildFake({ enrollment: { ...seed, verifiedAt: NOW } });
    configureBus(fake.client);

    // Re-confirming would mint a second recovery-code set for an
    // account whose factor is already live — a code-set reset that
    // needs no knowledge of the current codes.
    await expect(
      run({ code: totpFor(seed.secretBase32).generate(), idempotencyKey: "confirm-6" })
    ).rejects.toMatchObject({ code: "MFA_NO_PENDING_ENROLLMENT" });
    expect(fake.tx.recoveryCode.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses an enrollment sealed for a different organization", async () => {
    const seed = await pendingEnrollment({ organizationId: OTHER_ORG_ID });
    const fake = buildFake({ enrollment: seed });
    configureBus(fake.client);

    // Row-level security is the first line here; the tenant-bound KEK
    // is the second, and this pins the second — a leaked row from
    // another tenant is undecryptable, so it can never be activated.
    await expect(
      run({ code: totpFor(seed.secretBase32).generate(), idempotencyKey: "confirm-7" })
    ).rejects.toMatchObject({ code: "KMS_KEY_NOT_FOUND" });
    expect(fake.tx.mfaEnrollment.update).not.toHaveBeenCalled();
    expect(fake.tx.user.update).not.toHaveBeenCalled();
  });

  it("refuses an enrollment sealed for a different operator in the same organization", async () => {
    const seed = await pendingEnrollment({ userId: OTHER_USER_ID });
    const fake = buildFake({ enrollment: seed });
    configureBus(fake.client);

    // Same tenant, so the KEK unwraps — the per-user AAD is what stops
    // one operator from adopting a colleague's pending secret.
    await expect(
      run({ code: totpFor(seed.secretBase32).generate(), idempotencyKey: "confirm-8" })
    ).rejects.toMatchObject({ code: "AAD_MISMATCH" });
    expect(fake.tx.user.update).not.toHaveBeenCalled();
  });

  it("persists recovery codes only as hashes and discards the previous unused set", async () => {
    const seed = await pendingEnrollment();
    const fake = buildFake({ enrollment: seed });
    configureBus(fake.client);

    const out = await run({
      code: totpFor(seed.secretBase32).generate(),
      idempotencyKey: "confirm-9",
    });

    // Already-redeemed codes keep their usedAt stamp; only the live
    // ones are swept, so re-enrolling cannot erase that history.
    expect(fake.tx.recoveryCode.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, usedAt: null },
    });

    const rows = fake.tx.recoveryCode.create.mock.calls.map(
      (call) =>
        (call[0] as { data: { organizationId: string; userId: string; codeHash: string } }).data
    );
    expect(rows).toHaveLength(RECOVERY_CODE_COUNT);
    for (const [index, row] of rows.entries()) {
      const plaintext = out.recoveryCodes[index]!;
      expect(row.codeHash).not.toBe(plaintext);
      // The stored form is the hash of the separator-stripped code, so
      // a database reader holds nothing redeemable.
      expect(row.codeHash).toBe(`h:${plaintext.replace(/-/g, "")}`);
      expect(row).toMatchObject({ organizationId: ORG_ID, userId: USER_ID });
    }
  });

  it("keeps the recovery codes out of the audit trail and the command log", async () => {
    const seed = await pendingEnrollment();
    const fake = buildFake({ enrollment: seed });
    configureBus(fake.client);

    const out = await run({
      code: totpFor(seed.secretBase32).generate(),
      idempotencyKey: "confirm-10",
    });

    const persisted = serializeCalls([
      ...fake.tx.auditLog.create.mock.calls,
      ...fake.tx.eventOutbox.createMany.mock.calls,
      ...fake.tx.commandLog.create.mock.calls,
      ...fake.tx.commandLog.update.mock.calls,
      ...fake.tx.idempotencyKey.create.mock.calls,
    ]);
    for (const code of out.recoveryCodes) {
      expect(persisted).not.toContain(code);
    }
    // The audit row records how many were issued, never which.
    expect(fake.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ recoveryCodesIssued: RECOVERY_CODE_COUNT }),
        }),
      })
    );

    const succeeded = fake.tx.commandLog.update.mock.calls.at(-1)![0] as {
      data: { responsePayload: Record<string, unknown> };
    };
    expect(succeeded.data.responsePayload).toMatchObject({ recoveryCodes: "[Redacted]" });
  });
});
