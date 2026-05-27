// InviteUser — admin "invite a teammate" path.
//
// Creates a Pharmax `user` row in INVITED status, no clerkUserId
// (they're linked when they sign in for the first time via
// `resolveOperatorTenancyContext`'s email-based auto-link).
//
// Workflow:
//   1. Admin invites a teammate from /ops/admin/users (email +
//      display name).
//   2. This command writes a user row with status=INVITED.
//   3. Admin shares the sign-up URL (Clerk handles the auth flow
//      separately — magic link / email / OAuth, depending on the
//      org's Clerk config).
//   4. Teammate signs in via Clerk. resolveOperatorTenancyContext
//      sees no Pharmax user with their clerkUserId, falls back to
//      fetching their email from Clerk, finds the INVITED row
//      with that email, and links clerkUserId + flips status to
//      ACTIVE in a single transaction.
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
