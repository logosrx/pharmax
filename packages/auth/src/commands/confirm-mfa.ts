// ConfirmMfa — verify a code against the pending enrollment and activate.
//
// On success: marks the enrollment verified, flips `user.mfaEnrolled`,
// and issues a fresh set of single-use recovery codes (returned ONCE,
// stored only as Argon2id hashes). Self-service.
//
// PHI: none. The recovery codes are sensitive and on the redaction
// allowlist so they never reach `command_log`.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { z } from "zod";

import { getAuthConfiguration } from "../configure.js";
import { mfaInvalidError, mfaNoPendingEnrollmentError } from "../errors.js";
import { generateRecoveryCodes, hashRecoveryCode } from "../mfa/recovery-codes.js";
import { openTotpSecret } from "../mfa/secret-seal.js";
import { verifyTotpCode } from "../mfa/totp.js";

const inputSchema = z
  .object({
    code: z.string().min(1).max(64),
  })
  .strict();

export type ConfirmMfaInput = z.infer<typeof inputSchema>;

export interface ConfirmMfaOutput {
  readonly enrollmentId: string;
  /** Single-use recovery codes, shown ONCE. Redacted from logs. */
  readonly recoveryCodes: ReadonlyArray<string>;
}

export const ConfirmMfa: Command<ConfirmMfaInput, ConfirmMfaOutput> = {
  name: "ConfirmMfa",
  inputSchema,
  permission: null,
  redactFields: ["recoveryCodes"],

  async handle({ input, ctx, tx, commandLogId, clock }): Promise<HandlerResult<ConfirmMfaOutput>> {
    const config = getAuthConfiguration();
    const userId = ctx.actor.userId;
    const now = clock.now();

    const pending = await tx.mfaEnrollment.findFirst({
      where: { userId, verifiedAt: null, disabledAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, secretCiphertext: true },
    });
    if (pending === null) {
      throw mfaNoPendingEnrollmentError({ userId });
    }

    const secretBase32 = await openTotpSecret({
      ciphertext: pending.secretCiphertext,
      organizationId: ctx.organizationId,
      userId,
    });
    const ok = verifyTotpCode({
      secretBase32,
      issuer: config.mfa.issuer,
      accountName: userId,
      token: input.code,
      window: config.mfa.totpWindow,
    });
    if (!ok) {
      throw mfaInvalidError();
    }

    await tx.mfaEnrollment.update({ where: { id: pending.id }, data: { verifiedAt: now } });
    await tx.user.update({ where: { id: userId }, data: { mfaEnrolled: true } });

    // Fresh recovery-code set: discard any unused prior codes, mint new.
    await tx.recoveryCode.deleteMany({ where: { userId, usedAt: null } });
    const recoveryCodes = generateRecoveryCodes(config.mfa.recoveryCodeCount);
    for (const code of recoveryCodes) {
      const codeHash = await hashRecoveryCode(config.hasher, code);
      await tx.recoveryCode.create({
        data: { organizationId: ctx.organizationId, userId, codeHash, createdAt: now },
      });
    }

    return {
      output: Object.freeze({
        enrollmentId: pending.id,
        recoveryCodes: Object.freeze(recoveryCodes),
      }),
      audit: {
        action: "user.mfa.enrolled",
        resourceType: "User",
        resourceId: userId,
        metadata: {
          userId,
          enrollmentId: pending.id,
          recoveryCodesIssued: recoveryCodes.length,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "user.mfa.enrolled.v1",
          aggregateType: "User",
          aggregateId: userId,
          payload: {
            organizationId: ctx.organizationId,
            userId,
            enrollmentId: pending.id,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
