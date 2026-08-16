// InviteUser — admin "invite a teammate" path.
//
// Creates a Pharmax `user` row in INVITED status and no credentials.
// This command is only the first step; it deliberately does NOT mint
// a token, send mail, or activate anyone. Identity is in-house per
// ADR-0030 — there is no external provider to hand the operator off to.
//
// Workflow:
//   1. Admin invites a teammate from /ops/admin/users (email +
//      display name).
//   2. This command writes a user row with status=INVITED.
//   3. Post-commit, the route
//      (`apps/web/app/api/ops/admin/users/invite/route.ts`) dispatches
//      `IssueInvite` (@pharmax/auth) to mint a single-use, hashed
//      credential-setup token, and mails the accept-invite link.
//      Best-effort: a delivery failure does not undo the invite, and
//      the redundant-re-invite path below skips it.
//   4. The teammate opens the link and `AcceptInvite` (@pharmax/auth)
//      consumes the token, sets the initial password, and flips
//      INVITED → ACTIVE. It does not mint a session.
//   5. They then sign in through `SignIn`, which for a role on the MFA
//      floor runs the enrollment step before access is granted.
//
// Idempotency:
//   - Re-invitation of the same email returns the existing user
//     row (typed metadata flag `userAlreadyExists: true`) rather
//     than throwing — admins commonly resend invites and we want
//     that to be a no-op rather than a confusing error.
//   - The DB unique constraint on `(organizationId, email)` is
//     the loud guard against email racing.
//
// Permission: `users.manage` (ORGANIZATION scope).
//
// PHI: `email` and `displayName` are operator identifiers, not
// patient PHI. Audit + outbox metadata echoes both; safe to log.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { UserStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

const inputSchema = z
  .object({
    email: z.email().max(320),
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();

export type InviteUserInput = z.infer<typeof inputSchema>;

export interface InviteUserOutput {
  readonly userId: string;
  readonly email: string;
  readonly status: UserStatus;
  /** True iff a row with this (org, email) already existed. */
  readonly userAlreadyExists: boolean;
}

export const InviteUser: Command<InviteUserInput, InviteUserOutput> = {
  name: "InviteUser",
  inputSchema,
  permission: PERMISSIONS.USERS_MANAGE,
  redactFields: [],

  async handle({ input, ctx, tx, commandLogId }): Promise<HandlerResult<InviteUserOutput>> {
    const normalizedEmail = input.email.toLowerCase();

    const existing = await tx.user.findFirst({
      where: { organizationId: ctx.organizationId, email: normalizedEmail },
      select: { id: true, email: true, status: true },
    });
    if (existing !== null) {
      return {
        output: Object.freeze({
          userId: existing.id,
          email: existing.email,
          status: existing.status,
          userAlreadyExists: true,
        }),
        audit: {
          action: "org.user.invited_redundant",
          resourceType: "User",
          resourceId: existing.id,
          metadata: {
            userId: existing.id,
            email: normalizedEmail,
            status: existing.status,
            commandLogId,
          },
        },
        // No outbox event on the no-op path; idempotent re-invite
        // shouldn't fan out as a fresh signal to downstream
        // consumers.
        outboxEvents: [],
      };
    }

    const created = await tx.user.create({
      data: {
        organizationId: ctx.organizationId,
        email: normalizedEmail,
        displayName: input.displayName.trim(),
        status: UserStatus.INVITED,
      },
      select: { id: true, email: true, status: true },
    });

    return {
      output: Object.freeze({
        userId: created.id,
        email: created.email,
        status: created.status,
        userAlreadyExists: false,
      }),
      audit: {
        action: "org.user.invited",
        resourceType: "User",
        resourceId: created.id,
        metadata: {
          userId: created.id,
          email: created.email,
          displayName: input.displayName.trim(),
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.user.invited.v1",
          aggregateType: "User",
          aggregateId: created.id,
          payload: {
            organizationId: ctx.organizationId,
            userId: created.id,
            email: created.email,
            displayName: input.displayName.trim(),
            occurredAt: new Date().toISOString(),
          },
        },
      ],
    };
  },
};

export { UserStatus };
// re-export for callers; keeps `import { InviteUser, UserStatus } from "@pharmax/orgs"` ergonomic.
void errors;
