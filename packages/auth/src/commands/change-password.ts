// ChangePassword — authenticated self-service password change.
//
// Self-service (`permission: null`, like AcceptInvite): the actor
// operates on their OWN account (`ctx.actor.userId`). Steps:
//   1. Verify the current password (defeats session-hijack password
//      changes).
//   2. Enforce the password policy (length/composition/context) + the
//      breach screen.
//   3. Reject reuse against the recent `password_history` window.
//   4. Hash (Argon2id) + store; append the new hash to history; prune
//      beyond the policy depth.
//   5. Revoke all other active sessions (PASSWORD_CHANGED) so a stolen
//      session cannot outlive the credential it was born under. The
//      caller may keep the current session via `exceptSessionId`.
//
// The breach screen in step 2 is NOT performed here: it is a
// third-party network call and the bus has already opened the
// transaction by the time `handle` runs. Dispatch this command inside a
// `withScreenedPassword` frame so the check happens first:
//
//     await withScreenedPassword(newPassword, () =>
//       executeCommand(ChangePassword, input, { idempotencyKey })
//     );
//
// Without the frame the command fails closed with
// PASSWORD_BREACH_SCREEN_MISSING. See ../password/breach-screen.ts.
//
// PHI: none. Passwords are on the redaction allowlist.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { z } from "zod";

import { getAuthConfiguration } from "../configure.js";
import { currentPasswordInvalidError } from "../errors.js";
import { logBreachScreenBypass, requireBreachScreen } from "../password/breach-screen.js";
import { applyNewPassword } from "../password/set-password.js";

const inputSchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(1).max(1024),
    /** Keep this session alive; revoke all others. */
    exceptSessionId: z.string().uuid().optional(),
  })
  .strict();

export type ChangePasswordInput = z.infer<typeof inputSchema>;

export interface ChangePasswordOutput {
  readonly userId: string;
  readonly sessionsRevoked: number;
}

export const ChangePassword: Command<ChangePasswordInput, ChangePasswordOutput> = {
  name: "ChangePassword",
  inputSchema,
  // Self-service: the RBAC gate is "you are the authenticated actor".
  permission: null,
  redactFields: ["currentPassword", "newPassword"],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
    logger,
  }): Promise<HandlerResult<ChangePasswordOutput>> {
    const config = getAuthConfiguration();
    const userId = ctx.actor.userId;
    const now = clock.now();
    const breachScreen = requireBreachScreen(input.newPassword);

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { hashedPassword: true, email: true, displayName: true },
    });
    if (user === null) {
      // The actor's own row is missing — a system inconsistency, not a
      // user error.
      throw new errors.InternalError({
        code: "CHANGE_PASSWORD_ACTOR_MISSING",
        message: "Authenticated actor has no user row.",
        metadata: { userId },
      });
    }
    if (user.hashedPassword === null) {
      throw currentPasswordInvalidError();
    }

    const currentOk = await config.hasher.verify(user.hashedPassword, input.currentPassword);
    if (!currentOk) {
      throw currentPasswordInvalidError();
    }

    // Validate + store the new password (policy, breach, anti-reuse,
    // hash, history) via the shared core.
    const emailLocalPart = user.email.split("@")[0] ?? "";
    await applyNewPassword({
      tx,
      userId,
      organizationId: ctx.organizationId,
      plaintext: input.newPassword,
      disallowedSubstrings: [emailLocalPart, user.displayName],
      currentHash: user.hashedPassword,
      breachScreen,
      config,
      now,
    });
    logBreachScreenBypass(logger, breachScreen, { userId });

    // Revoke sessions (all, or all-but-current).
    const revoked = await tx.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(input.exceptSessionId === undefined ? {} : { id: { not: input.exceptSessionId } }),
      },
      data: { revokedAt: now, revokedReason: "PASSWORD_CHANGED" },
    });

    return {
      output: Object.freeze({ userId, sessionsRevoked: revoked.count }),
      audit: {
        action: "user.password_changed",
        resourceType: "User",
        resourceId: userId,
        metadata: {
          userId,
          sessionsRevoked: revoked.count,
          breachScreen: breachScreen.outcome,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "user.password_changed.v1",
          aggregateType: "User",
          aggregateId: userId,
          payload: {
            organizationId: ctx.organizationId,
            userId,
            sessionsRevoked: revoked.count,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
