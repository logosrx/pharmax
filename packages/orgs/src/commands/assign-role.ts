// AssignRole — admin "grant role X to user Y" path.
//
// Writes a `UserRole` row binding (user × role × optional scope).
// The scope (site / clinic / team) is OPTIONAL and is constrained
// by the role's own scope:
//
//   - ORGANIZATION-scope roles: scope fields all null.
//   - SITE-scope roles: REQUIRES siteId.
//   - CLINIC-scope roles: REQUIRES clinicId.
//   - TEAM-scope roles: REQUIRES teamId.
//
// The mismatch surfaces as a typed `ROLE_SCOPE_REQUIRES_*` code
// so the admin UI can render an actionable message.
//
// Idempotency:
//   - DB unique constraint on `(userId, roleId, siteId, clinicId,
//     teamId)` ensures a duplicate grant is rejected at the row
//     level. We catch P2002 and surface `USER_ROLE_ALREADY_GRANTED`
//     so admins re-clicking a button see a no-op message instead
//     of an opaque crash.
//
// Permission: `roles.manage` (ORGANIZATION scope).
//
// PHI: none. The user id + role code + scope ids are all
// operator-side identifiers.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { Prisma, RoleScope, UserStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const ASSIGN_ROLE_USER_NOT_FOUND = "ASSIGN_ROLE_USER_NOT_FOUND";
export const ASSIGN_ROLE_ROLE_NOT_FOUND = "ASSIGN_ROLE_ROLE_NOT_FOUND";
export const ASSIGN_ROLE_SCOPE_REQUIRES_SITE = "ASSIGN_ROLE_SCOPE_REQUIRES_SITE";
export const ASSIGN_ROLE_SCOPE_REQUIRES_CLINIC = "ASSIGN_ROLE_SCOPE_REQUIRES_CLINIC";
export const ASSIGN_ROLE_SCOPE_REQUIRES_TEAM = "ASSIGN_ROLE_SCOPE_REQUIRES_TEAM";
export const ASSIGN_ROLE_SCOPE_NOT_ALLOWED = "ASSIGN_ROLE_SCOPE_NOT_ALLOWED";
export const ASSIGN_ROLE_SITE_NOT_IN_ORG = "ASSIGN_ROLE_SITE_NOT_IN_ORG";
export const USER_ROLE_ALREADY_GRANTED = "USER_ROLE_ALREADY_GRANTED";

const inputSchema = z
  .object({
    userId: z.uuid(),
    /** Resolves to a `role.id` via `(organizationId, code)`. */
    roleCode: z.string().trim().min(1).max(64),
    /** Required when the role is SITE-scoped. */
    siteId: z.uuid().optional(),
    /** Required when the role is CLINIC-scoped. */
    clinicId: z.uuid().optional(),
    /** Required when the role is TEAM-scoped. */
    teamId: z.uuid().optional(),
  })
  .strict();

export type AssignRoleInput = z.infer<typeof inputSchema>;

export interface AssignRoleOutput {
  readonly userRoleId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly roleCode: string;
  readonly roleScope: RoleScope;
}

export const AssignRole: Command<AssignRoleInput, AssignRoleOutput> = {
  name: "AssignRole",
  inputSchema,
  permission: PERMISSIONS.ROLES_MANAGE,
  redactFields: [],

  async handle({ input, ctx, tx, commandLogId }): Promise<HandlerResult<AssignRoleOutput>> {
    const user = await tx.user.findFirst({
      where: { id: input.userId, organizationId: ctx.organizationId },
      select: { id: true, status: true },
    });
    if (user === null) {
      throw new errors.NotFoundError({
        code: ASSIGN_ROLE_USER_NOT_FOUND,
        message: "User not found in this organization.",
        metadata: { userId: input.userId },
      });
    }
    if (user.status === UserStatus.TERMINATED) {
      throw new errors.ConflictError({
        code: ASSIGN_ROLE_USER_NOT_FOUND,
        message: "Cannot grant a role to a terminated user.",
        metadata: { userId: input.userId, status: user.status },
      });
    }

    const role = await tx.role.findFirst({
      where: { organizationId: ctx.organizationId, code: input.roleCode },
      select: { id: true, scope: true },
    });
    if (role === null) {
      throw new errors.NotFoundError({
        code: ASSIGN_ROLE_ROLE_NOT_FOUND,
        message: `Role "${input.roleCode}" not found in this organization.`,
        metadata: { roleCode: input.roleCode },
      });
    }

    // Validate scope inputs against the role's declared scope.
    // ORG-scope roles MUST NOT carry any narrower scope.
    // SITE/CLINIC/TEAM roles REQUIRE that one field set and the
    // other two unset.
    const hasSite = input.siteId !== undefined;
    const hasClinic = input.clinicId !== undefined;
    const hasTeam = input.teamId !== undefined;
    const scopeFieldCount = (hasSite ? 1 : 0) + (hasClinic ? 1 : 0) + (hasTeam ? 1 : 0);

    switch (role.scope) {
      case RoleScope.ORGANIZATION:
        if (scopeFieldCount > 0) {
          throw new errors.ValidationError({
            code: ASSIGN_ROLE_SCOPE_NOT_ALLOWED,
            message: `Role "${input.roleCode}" is ORGANIZATION-scoped; siteId/clinicId/teamId must be omitted.`,
            metadata: { roleCode: input.roleCode, roleScope: role.scope },
          });
        }
        break;
      case RoleScope.SITE:
        if (!hasSite || hasClinic || hasTeam) {
          throw new errors.ValidationError({
            code: ASSIGN_ROLE_SCOPE_REQUIRES_SITE,
            message: `Role "${input.roleCode}" is SITE-scoped; siteId is required and clinicId/teamId must be omitted.`,
            metadata: { roleCode: input.roleCode, roleScope: role.scope },
          });
        }
        break;
      case RoleScope.CLINIC:
        if (!hasClinic || hasSite || hasTeam) {
          throw new errors.ValidationError({
            code: ASSIGN_ROLE_SCOPE_REQUIRES_CLINIC,
            message: `Role "${input.roleCode}" is CLINIC-scoped; clinicId is required and siteId/teamId must be omitted.`,
            metadata: { roleCode: input.roleCode, roleScope: role.scope },
          });
        }
        break;
      case RoleScope.TEAM:
        if (!hasTeam || hasSite || hasClinic) {
          throw new errors.ValidationError({
            code: ASSIGN_ROLE_SCOPE_REQUIRES_TEAM,
            message: `Role "${input.roleCode}" is TEAM-scoped; teamId is required and siteId/clinicId must be omitted.`,
            metadata: { roleCode: input.roleCode, roleScope: role.scope },
          });
        }
        break;
      default: {
        const exhaustive: never = role.scope;
        throw new errors.InternalError({
          code: "ASSIGN_ROLE_UNKNOWN_SCOPE",
          message: `Unknown role scope: ${String(exhaustive)}.`,
        });
      }
    }

    // Verify the scope id (if provided) belongs to this org. Defense
    // in depth above the Prisma extension's filter — an admin
    // pasting a UUID from another org would otherwise create a
    // dangling row.
    if (hasSite) {
      const site = await tx.pharmacySite.findFirst({
        where: { id: input.siteId!, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (site === null) {
        throw new errors.NotFoundError({
          code: ASSIGN_ROLE_SITE_NOT_IN_ORG,
          message: "Site not found in this organization.",
          metadata: { siteId: input.siteId },
        });
      }
    }

    let userRoleId: string;
    try {
      const created = await tx.userRole.create({
        data: {
          userId: input.userId,
          roleId: role.id,
          organizationId: ctx.organizationId,
          siteId: input.siteId ?? null,
          clinicId: input.clinicId ?? null,
          teamId: input.teamId ?? null,
        },
        select: { id: true },
      });
      userRoleId = created.id;
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        throw new errors.ConflictError({
          code: USER_ROLE_ALREADY_GRANTED,
          message: "This grant already exists for the user × role × scope combination.",
          metadata: {
            userId: input.userId,
            roleCode: input.roleCode,
            siteId: input.siteId ?? null,
            clinicId: input.clinicId ?? null,
            teamId: input.teamId ?? null,
          },
          cause,
        });
      }
      throw cause;
    }

    return {
      output: Object.freeze({
        userRoleId,
        userId: input.userId,
        roleId: role.id,
        roleCode: input.roleCode,
        roleScope: role.scope,
      }),
      audit: {
        action: "org.user_role.granted",
        resourceType: "UserRole",
        resourceId: userRoleId,
        metadata: {
          userId: input.userId,
          roleId: role.id,
          roleCode: input.roleCode,
          roleScope: role.scope,
          siteId: input.siteId ?? null,
          clinicId: input.clinicId ?? null,
          teamId: input.teamId ?? null,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.user_role.granted.v1",
          aggregateType: "UserRole",
          aggregateId: userRoleId,
          payload: {
            organizationId: ctx.organizationId,
            userId: input.userId,
            roleId: role.id,
            roleCode: input.roleCode,
            roleScope: role.scope,
            siteId: input.siteId ?? null,
            clinicId: input.clinicId ?? null,
            teamId: input.teamId ?? null,
            occurredAt: new Date().toISOString(),
          },
        },
      ],
    };
  },
};
