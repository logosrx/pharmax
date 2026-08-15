// AcceptInvite — consume a setup token, set the initial password, and
// activate an INVITED operator (ADR-0030).
//
// A SYSTEM command: pre-auth (the caller holds only the emailed token).
// The token resolves to the user + org; the command requires the user to
// be INVITED (a consumed/expired token, or a user already ACTIVE, is an
// opaque RESET_TOKEN_INVALID — no enumeration). On success it sets the
// password via the shared core, flips INVITED → ACTIVE, and consumes the
// token. It does NOT mint a session — the operator then signs in
// normally (which, for a floor role, will run the MFA enrollment step).
//
// The INVITED requirement is also what keeps this flow and ResetPassword
// mutually exclusive: reset and invite tokens share one table with no
// purpose column, so each command excludes the other's tokens by the
// user status they imply (ResetPassword requires ACTIVE).
//
// The organization on the token row is not taken on trust either. It is
// what this command files the audit entry and the outbox event under,
// so a row whose `organizationId` did not match its user's would write
// one tenant's activation into another tenant's record of truth. The
// user is therefore read with BOTH ids, and a mismatch resolves to no
// user at all — the same opaque refusal as an unknown token. IssueInvite
// proves that pairing before minting, so this is defence in depth: the
// table predates that check, and a future writer to
// `password_reset_token` would not necessarily repeat it.
//
// Callers must dispatch this inside `withScreenedPassword` so the breach
// check happens before the transaction opens — see
// ../password/breach-screen.ts. `acceptInvite` does that.

import { UserStatus } from "@pharmax/database";
import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
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

export type AcceptInviteInput = z.infer<typeof inputSchema>;

export interface AcceptInviteOutput {
  readonly userId: string;
}

export const AcceptInvite: SystemCommand<AcceptInviteInput, AcceptInviteOutput> = {
  name: "AcceptInvite",
  inputSchema,
  redactFields: ["rawToken", "newPassword"],

  async handle({
    input,
    tx,
    commandLogId,
    clock,
    logger,
  }): Promise<SystemHandlerResult<AcceptInviteOutput>> {
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

    // Read by user AND organization together, so a token whose pair is
    // mismatched never loads a user row at all — the org this command
    // then audits and publishes under is proven, not assumed.
    const user = await tx.user.findFirst({
      where: { id: token.userId, organizationId: token.organizationId },
      select: { email: true, displayName: true, status: true },
    });
    // The setup flow only applies to a still-INVITED user. Anything else
    // (already ACTIVE, suspended, terminated, or a user who does not
    // belong to the token's organization) is an opaque invalid token: a
    // caller holding only an emailed link must not be able to tell those
    // cases apart.
    if (user === null || user.status !== UserStatus.INVITED) {
      throw resetTokenInvalidError();
    }

    const emailLocalPart = user.email.split("@")[0] ?? "";
    await applyNewPassword({
      tx,
      userId: token.userId,
      organizationId: token.organizationId,
      plaintext: input.newPassword,
      disallowedSubstrings: [emailLocalPart, user.displayName],
      // An invited user has no prior password.
      currentHash: null,
      breachScreen,
      config,
      now,
    });
    logBreachScreenBypass(logger, breachScreen, { userId: token.userId });

    await tx.user.update({
      where: { id: token.userId },
      data: { status: UserStatus.ACTIVE },
    });
    await tx.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: now } });

    return {
      output: Object.freeze({ userId: token.userId }),
      targetOrganizationId: token.organizationId,
      audit: {
        action: "user.invite_accepted",
        resourceType: "User",
        resourceId: token.userId,
        metadata: { userId: token.userId, breachScreen: breachScreen.outcome, commandLogId },
      },
      outboxEvents: [
        {
          eventType: "user.invite_accepted.v1",
          aggregateType: "User",
          aggregateId: token.userId,
          payload: {
            organizationId: token.organizationId,
            userId: token.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
