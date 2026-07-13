// SignIn — the successful-authentication command.
//
// A SYSTEM command: at sign-in there is no user tenancy context yet, but
// the target organization IS known (the web tier resolves it from the
// sign-in subdomain and passes `organizationId`). Running through the bus
// gives us `command_log` + `audit_log` ("user.signed_in") + `event_outbox`
// ("user.signed_in.v1") for free — the centralized audit contract.
//
// This command is the SUCCESS path only. Any failure (bad password,
// inactive user, MFA required/invalid) THROWS a typed AuthenticationError;
// the bus rolls the tx back and writes no command_log. The
// `signIn` orchestration wrapper (../sign-in.ts) records the failure in
// the `login_attempt` ledger (its own committed tx) and enforces lockout.
//
// PHI rule: no PHI here — operator email/displayName only. `password`,
// `mfaCode` (input) and `rawToken` (output) are on the bus redaction
// allowlist so they never reach `command_log`.

import { UserStatus } from "@pharmax/database";
import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { z } from "zod";

import { getAuthConfiguration } from "../configure.js";
import { invalidCredentialsError, mfaInvalidError, mfaRequiredError } from "../errors.js";
import { verifyRecoveryCode } from "../mfa/recovery-codes.js";
import { openTotpSecret } from "../mfa/secret-seal.js";
import { verifyTotpCode } from "../mfa/totp.js";
import { createSessionInTx } from "../session/service.js";

const inputSchema = z
  .object({
    organizationId: z.string().uuid(),
    email: z.string().email().max(320),
    password: z.string().min(1).max(1024),
    /** TOTP code or recovery code, when the account has MFA enrolled. */
    mfaCode: z.string().min(1).max(64).optional(),
    ipAddress: z.string().max(64).optional(),
    userAgent: z.string().max(512).optional(),
  })
  .strict();

export type SignInInput = z.infer<typeof inputSchema>;

export interface SignInOutput {
  readonly userId: string;
  readonly organizationId: string;
  readonly sessionId: string;
  /** Bearer session token. Redacted from command_log; returned to caller. */
  readonly rawToken: string;
  readonly mfaSatisfied: boolean;
}

export const SignIn: SystemCommand<SignInInput, SignInOutput> = {
  name: "SignIn",
  inputSchema,
  redactFields: ["password", "mfaCode", "rawToken"],

  async handle({ input, tx, commandLogId, clock }): Promise<SystemHandlerResult<SignInOutput>> {
    const config = getAuthConfiguration();
    const now = clock.now();
    const email = input.email.toLowerCase();

    const user = await tx.user.findUnique({
      where: { organizationId_email: { organizationId: input.organizationId, email } },
      select: {
        id: true,
        status: true,
        hashedPassword: true,
        mfaEnrolled: true,
      },
    });

    if (user === null) {
      throw invalidCredentialsError("user_not_found");
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw invalidCredentialsError("user_not_active");
    }
    if (user.hashedPassword === null) {
      // INVITED user who never set a password, or a system account.
      throw invalidCredentialsError("no_password_set");
    }

    const passwordOk = await config.hasher.verify(user.hashedPassword, input.password);
    if (!passwordOk) {
      throw invalidCredentialsError("bad_password");
    }

    // Transparent KDF upgrade: if the stored hash used weaker params
    // than the current policy, re-hash with the verified plaintext.
    let rehashed = false;
    if (config.hasher.needsRehash(user.hashedPassword)) {
      const upgraded = await config.hasher.hash(input.password);
      await tx.user.update({ where: { id: user.id }, data: { hashedPassword: upgraded } });
      rehashed = true;
    }

    // MFA floor: required if the user holds a floor role OR has MFA on.
    const roleCodes = await loadRoleCodes(tx, user.id, input.organizationId);
    const requiredByRole = intersects(roleCodes, config.mfa.requiredRoleCodes);
    const mfaRequired = requiredByRole || user.mfaEnrolled;

    let mfaUsed = false;
    if (mfaRequired) {
      const enrollment = await tx.mfaEnrollment.findFirst({
        where: { userId: user.id, disabledAt: null, verifiedAt: { not: null } },
        select: { id: true, secretCiphertext: true },
      });

      if (enrollment === null) {
        // Floor role with no authenticator yet — must enroll before
        // access. The web tier routes MFA_REQUIRED(enrolled:false) to
        // the enrollment flow.
        throw mfaRequiredError({ userId: user.id, enrolled: false });
      }
      if (input.mfaCode === undefined) {
        throw mfaRequiredError({ userId: user.id, enrolled: true });
      }

      const verified = await verifyMfaCode({
        tx,
        userId: user.id,
        organizationId: input.organizationId,
        secretCiphertext: enrollment.secretCiphertext,
        code: input.mfaCode,
      });
      if (!verified) {
        throw mfaInvalidError();
      }
      mfaUsed = true;
    }

    // We only reach here once the MFA step (if any) is satisfied.
    const session = await createSessionInTx({
      tx,
      userId: user.id,
      organizationId: input.organizationId,
      mfaSatisfied: true,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      config,
    });

    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });

    const output: SignInOutput = {
      userId: user.id,
      organizationId: input.organizationId,
      sessionId: session.sessionId,
      rawToken: session.rawToken,
      mfaSatisfied: true,
    };

    return {
      output,
      targetOrganizationId: input.organizationId,
      audit: {
        action: "user.signed_in",
        resourceType: "User",
        resourceId: user.id,
        metadata: { commandLogId, mfaUsed, rehashed },
      },
      outboxEvents: [
        {
          eventType: "user.signed_in.v1",
          aggregateType: "User",
          aggregateId: user.id,
          payload: {
            userId: user.id,
            organizationId: input.organizationId,
            sessionId: session.sessionId,
            mfaUsed,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};

// --- helpers ---------------------------------------------------------------

type TxLike = Parameters<SystemCommand<SignInInput, SignInOutput>["handle"]>[0]["tx"];

async function loadRoleCodes(
  tx: TxLike,
  userId: string,
  organizationId: string
): Promise<ReadonlySet<string>> {
  const rows = await tx.userRole.findMany({
    where: { userId, organizationId },
    select: { role: { select: { code: true } } },
  });
  return new Set(rows.map((r) => r.role.code));
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) {
    if (b.has(x)) return true;
  }
  return false;
}

/**
 * Verify a submitted MFA code against the enrolled TOTP secret, falling
 * back to single-use recovery codes. A consumed recovery code is stamped
 * `usedAt` in the same tx so it cannot be replayed.
 */
async function verifyMfaCode(input: {
  readonly tx: TxLike;
  readonly userId: string;
  readonly organizationId: string;
  readonly secretCiphertext: string;
  readonly code: string;
}): Promise<boolean> {
  const config = getAuthConfiguration();

  const secretBase32 = await openTotpSecret({
    ciphertext: input.secretCiphertext,
    organizationId: input.organizationId,
    userId: input.userId,
  });

  const totpOk = verifyTotpCode({
    secretBase32,
    issuer: config.mfa.issuer,
    accountName: input.userId,
    token: input.code,
    window: config.mfa.totpWindow,
  });
  if (totpOk) return true;

  // Recovery-code fallback. Compare against unused codes; consume on hit.
  const codes = await input.tx.recoveryCode.findMany({
    where: { userId: input.userId, usedAt: null },
    select: { id: true, codeHash: true },
  });
  for (const row of codes) {
    if (await verifyRecoveryCode(config.hasher, input.code, row.codeHash)) {
      await input.tx.recoveryCode.update({
        where: { id: row.id },
        data: { usedAt: config.clock.now() },
      });
      return true;
    }
  }
  return false;
}
