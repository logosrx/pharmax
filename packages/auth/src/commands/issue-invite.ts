// IssueInvite — mint a credential-setup token for an INVITED user.
//
// After an admin creates a user (orgs `InviteUser`, status=INVITED), the
// operator needs a one-time link to set their initial password and
// activate. This mints that token. It reuses the `password_reset_token`
// table — the shape is identical (hashed, expiring, single-use token to
// set a password) — with a longer TTL suited to an invitation.
//
// The raw token is RETURNED to the caller (redacted from command_log) so
// the admin route can build the accept-invite URL and deliver it (via
// the mailer port, or surfaced to the admin to share directly). It is
// persisted only as a SHA-256 hash.

import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { z } from "zod";

import { hashSessionToken, mintSessionToken } from "../session/token.js";

/** Invitations are valid for 7 days (vs. 1 hour for a reset). */
export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const inputSchema = z
  .object({
    userId: z.string().uuid(),
    organizationId: z.string().uuid(),
  })
  .strict();

export type IssueInviteInput = z.infer<typeof inputSchema>;

export interface IssueInviteOutput {
  readonly rawToken: string;
  readonly expiresAt: Date;
}

export const IssueInvite: SystemCommand<IssueInviteInput, IssueInviteOutput> = {
  name: "IssueInvite",
  inputSchema,
  redactFields: ["rawToken"],

  async handle({
    input,
    tx,
    commandLogId,
    clock,
  }): Promise<SystemHandlerResult<IssueInviteOutput>> {
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + DEFAULT_INVITE_TTL_MS);

    // Invalidate any prior unused setup token so only the newest link works.
    await tx.passwordResetToken.updateMany({
      where: { userId: input.userId, usedAt: null },
      data: { usedAt: now },
    });

    const rawToken = mintSessionToken(32);
    await tx.passwordResetToken.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        tokenHash: hashSessionToken(rawToken),
        expiresAt,
        createdAt: now,
      },
    });

    return {
      output: Object.freeze({ rawToken, expiresAt }),
      targetOrganizationId: input.organizationId,
      audit: {
        action: "user.invite_issued",
        resourceType: "User",
        resourceId: input.userId,
        metadata: { userId: input.userId, expiresAt: expiresAt.toISOString(), commandLogId },
      },
      outboxEvents: [
        {
          eventType: "user.invite_issued.v1",
          aggregateType: "User",
          aggregateId: input.userId,
          payload: {
            organizationId: input.organizationId,
            userId: input.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
