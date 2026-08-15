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
//
// `organizationId` is NOT taken on trust. It arrives as an input
// independent of `userId`, and a SystemCommand runs in system context,
// where the tenancy extension passes through by design — so nothing
// downstream would catch a mispaired call. The blast radius is wider
// than a misfiled row: AcceptInvite reads the org back OFF the token
// row, so a token filed under the wrong org lands that user's
// activation in a different organization's audit trail and event
// stream. Membership is therefore proved against the user row before
// anything is minted, and the prior-token sweep carries the org too.

import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { z } from "zod";

import { hashSessionToken, mintSessionToken } from "../session/token.js";

/** Invitations are valid for 7 days (vs. 1 hour for a reset). */
export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** No such user in `organizationId` — or no such user at all. */
export const ISSUE_INVITE_USER_NOT_FOUND = "ISSUE_INVITE_USER_NOT_FOUND";

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

    // One org-scoped read, so a row belonging to another organization
    // is never loaded at all — not fetched by id and compared after.
    const user = await tx.user.findFirst({
      where: { id: input.userId, organizationId: input.organizationId },
      select: { id: true },
    });
    if (user === null) {
      // The same refusal whether the user does not exist or exists in
      // another organization. Telling those apart would let a caller
      // probe ids across the tenancy boundary.
      throw new errors.NotFoundError({
        code: ISSUE_INVITE_USER_NOT_FOUND,
        message: "User not found in this organization.",
        metadata: { userId: input.userId, organizationId: input.organizationId },
      });
    }

    // Invalidate any prior unused setup token so only the newest link
    // works. Scoped by organization as well as user: system context
    // passes through the tenancy extension, so the scope only exists
    // if it is written here.
    await tx.passwordResetToken.updateMany({
      where: { userId: input.userId, organizationId: input.organizationId, usedAt: null },
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
