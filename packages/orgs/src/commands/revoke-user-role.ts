// RevokeUserRole — admin "remove role grant from user" path.
//
// Deletes a single `UserRole` row identified by its id. The grant
// must belong to the operator's organization (defense-in-depth
// above the Prisma extension's filter).
//
// Audit semantics:
//   - We READ the grant before deleting so the audit metadata
//     captures WHICH role + scope was revoked (not just the
//     UserRole id, which is meaningless to a SOC 2 auditor).
//   - The cascade on `UserRole.user` is `Cascade`, but we're
//     deleting a single row directly, not the user — so no
//     downstream rows are affected beyond the grant itself.
//
// Idempotency:
//   - Admin re-clicks a "revoke" button → second call returns
//     `USER_ROLE_NOT_FOUND`. We surface that as a typed flash
//     error rather than as a generic 5xx.
//
// Permission: `roles.manage` (ORGANIZATION scope).

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const USER_ROLE_NOT_FOUND = "USER_ROLE_NOT_FOUND";

const inputSchema = z
  .object({
    userRoleId: z.uuid(),
  })
  .strict();

export type RevokeUserRoleInput = z.infer<typeof inputSchema>;

export interface RevokeUserRoleOutput {
  readonly userRoleId: string;
  readonly userId: string;
  readonly roleId: string;
}

export const RevokeUserRole: Command<RevokeUserRoleInput, RevokeUserRoleOutput> = {
  name: "RevokeUserRole",
  inputSchema,
  permission: PERMISSIONS.ROLES_MANAGE,
  redactFields: [],

  async handle({ input, ctx, tx, commandLogId }): Promise<HandlerResult<RevokeUserRoleOutput>> {
    const grant = await tx.userRole.findFirst({
      where: { id: input.userRoleId, organizationId: ctx.organizationId },
      select: {
        id: true,
        userId: true,
        roleId: true,
        siteId: true,
        clinicId: true,
        teamId: true,
        role: { select: { code: true, scope: true } },
      },
    });
    if (grant === null) {
      throw new errors.NotFoundError({
        code: USER_ROLE_NOT_FOUND,
        message: "User-role grant not found in this organization.",
        metadata: { userRoleId: input.userRoleId },
      });
    }

    await tx.userRole.delete({ where: { id: grant.id } });

    return {
      output: Object.freeze({
        userRoleId: grant.id,
        userId: grant.userId,
        roleId: grant.roleId,
      }),
      audit: {
        action: "org.user_role.revoked",
        resourceType: "UserRole",
        resourceId: grant.id,
        metadata: {
          userId: grant.userId,
          roleId: grant.roleId,
          roleCode: grant.role.code,
          roleScope: grant.role.scope,
          siteId: grant.siteId,
          clinicId: grant.clinicId,
          teamId: grant.teamId,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.user_role.revoked.v1",
          aggregateType: "UserRole",
          aggregateId: grant.id,
          payload: {
            organizationId: ctx.organizationId,
            userId: grant.userId,
            roleId: grant.roleId,
            roleCode: grant.role.code,
            roleScope: grant.role.scope,
            siteId: grant.siteId,
            clinicId: grant.clinicId,
            teamId: grant.teamId,
            occurredAt: new Date().toISOString(),
          },
        },
      ],
    };
  },
};
