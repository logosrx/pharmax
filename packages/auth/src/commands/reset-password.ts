// ResetPassword — consume a reset token and set a new password.
//
// A SYSTEM command: it is pre-auth (the caller holds only the emailed
// token, no session). The token IS the authorization — resolving it by
// hash yields the user + org, so the command runs in system context and
// writes audit/outbox under that org. Invalid / used / expired tokens,
// and any user who is not ACTIVE, surface as a single opaque
// `RESET_TOKEN_INVALID`.
//
// The ACTIVE requirement carries more weight than it looks. Reset
// tokens and invite tokens are the same row shape in
// `password_reset_token` with no purpose discriminator, so without it:
//
//   - A 7-day INVITE token redeemed here would succeed. It would set a
//     password on a still-INVITED user, burn the single-use link, and
//     audit the act as `user.password_reset`. The operator then cannot
//     sign in (SignIn requires ACTIVE) and onboarding has to restart —
//     a denial of service on onboarding with a misleading audit trail.
//   - A SUSPENDED user with an outstanding reset token could still
//     rotate their password. DeactivateUser revokes sessions but does
//     not invalidate outstanding tokens, so the link would survive
//     off-boarding.
//
// Requiring ACTIVE here also makes the two flows mutually exclusive
// using state that already exists: an invite token's user is INVITED so
// this command refuses it, and a reset token's user is ACTIVE so
// AcceptInvite refuses it (it requires INVITED). No schema change and
// no `purpose` column needed.
//
// Callers must dispatch this inside `withScreenedPassword` so the
// breach check happens before the transaction opens — see
// ../password/breach-screen.ts. `resetPassword` does that.
//
// On success: sets the new password (shared policy/breach/reuse core),
// consumes the token, and revokes ALL of the user's sessions
// (PASSWORD_CHANGED) — a reset implies the account may be compromised,
// so every existing session dies.

import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { UserStatus } from "@pharmax/database";
import { z } from "zod";

import { getAuthConfiguration } from "../configure.js";
import { resetTokenInvalidError } from "../errors.js";
import { logBreachScreenBypass, requireBreachScreen } from "../password/breach-screen.js";
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
    logger,
  }): Promise<SystemHandlerResult<ResetPasswordOutput>> {
    const config = getAuthConfiguration();
    const now = clock.now();
    const breachScreen = requireBreachScreen(input.newPassword);

    const token = await tx.passwordResetToken.findUnique({
      where: { tokenHash: hashSessionToken(input.rawToken) },
      select: { id: true, userId: true, organizationId: true, expiresAt: true, usedAt: true },
    });
    if (token === null || token.usedAt !== null || token.expiresAt.getTime() <= now.getTime()) {
      throw resetTokenInvalidError();
    }

    const user = await tx.user.findUnique({
      where: { id: token.userId },
      select: { email: true, displayName: true, hashedPassword: true, status: true },
    });
    // A missing user, or any user who is not ACTIVE (still INVITED,
    // suspended, terminated), is the SAME opaque invalid token. A
    // distinct code for "suspended" would answer "does this account
    // exist, and what state is it in?" for anyone holding a stale link,
    // which is an account-enumeration oracle on a pre-auth endpoint.
    if (user === null || user.status !== UserStatus.ACTIVE) {
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
      breachScreen,
      config,
      now,
    });
    logBreachScreenBypass(logger, breachScreen, { userId: token.userId });

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
        metadata: {
          userId: token.userId,
          sessionsRevoked: revoked.count,
          // Durable per-credential record of whether the breach corpus
          // actually answered for this password.
          breachScreen: breachScreen.outcome,
          commandLogId,
        },
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
