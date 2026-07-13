// ResetPassword — consume a reset token and set a new password.
//
// A SYSTEM command: it is pre-auth (the caller holds only the emailed
// token, no session). The token IS the authorization — resolving it by
// hash yields the user + org, so the command runs in system context and
// writes audit/outbox under that org. Invalid / used / expired tokens
// surface as a single opaque `RESET_TOKEN_INVALID`.
//
// On success: sets the new password (shared policy/breach/reuse core),
// consumes the token, and revokes ALL of the user's sessions
// (PASSWORD_CHANGED) — a reset implies the account may be compromised,
// so every existing session dies.

import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { z } from "zod";

import { getAuthConfiguration } from "../configure.js";
import { resetTokenInvalidError } from "../errors.js";
import { applyNewPassword } from "../password/set-password.js";
import { hashSessionToken } from "../session/token.js";

const inputSchema = z
  .object({
    rawToken: z.string().min(1).max(512),
    newPassword: z.string().min(1).max(1024),
  })
  .strict();

export type ResetPasswordInput = z.infer<typeof inputSchema>;

export interface ResetPasswordOutput {
  readonly userId: string;
  readonly sessionsRevoked: number;
}

export const ResetPassword: SystemCommand<ResetPasswordInput, ResetPasswordOutput> = {
  name: "ResetPassword",
  inputSchema,
  redactFields: ["rawToken", "newPassword"],

  async handle({
    input,
    tx,
    commandLogId,
    clock,
  }): Promise<SystemHandlerResult<ResetPasswordOutput>> {
    const config = getAuthConfiguration();
    const now = clock.now();

    const token = await tx.passwordResetToken.findUnique({
      where: { tokenHash: hashSessionToken(input.rawToken) },
      select: { id: true, userId: true, organizationId: true, expiresAt: true, usedAt: true },
    });
    if (token === null || token.usedAt !== null || token.expiresAt.getTime() <= now.getTime()) {
      throw resetTokenInvalidError();
    }

    const user = await tx.user.findUnique({
      where: { id: token.userId },
      select: { email: true, displayName: true, hashedPassword: true },
    });
    if (user === null) {
      // Token references a missing user — treat as invalid, do not leak.
      throw resetTokenInvalidError();
    }

    const emailLocalPart = user.email.split("@")[0] ?? "";
    await applyNewPassword({
      tx,
      userId: token.userId,
      organizationId: token.organizationId,
      plaintext: input.newPassword,
      disallowedSubstrings: [emailLocalPart, user.displayName],
      currentHash: user.hashedPassword,
      config,
      now,
    });

    // Consume the token (single-use).
    await tx.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: now } });

    // A reset kills every session — the credential the sessions were
    // born under is gone.
    const revoked = await tx.authSession.updateMany({
      where: { userId: token.userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: "PASSWORD_CHANGED" },
    });

    return {
      output: Object.freeze({ userId: token.userId, sessionsRevoked: revoked.count }),
      targetOrganizationId: token.organizationId,
      audit: {
        action: "user.password_reset",
        resourceType: "User",
        resourceId: token.userId,
        metadata: { userId: token.userId, sessionsRevoked: revoked.count, commandLogId },
      },
      outboxEvents: [
        {
          eventType: "user.password_reset.v1",
          aggregateType: "User",
          aggregateId: token.userId,
          payload: {
            organizationId: token.organizationId,
            userId: token.userId,
            sessionsRevoked: revoked.count,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
