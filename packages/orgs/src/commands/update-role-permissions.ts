// UpdateRolePermissions — admin "edit a custom role's privilege set".
//
// Full-replacement semantics: the input carries the COMPLETE desired
// permission-code set; the handler computes the added/removed diff
// against the current `RolePermission` rows and applies it. Full
// replacement (vs. add/remove deltas) makes the admin form trivially
// idempotent — what you see checked is what the role grants.
//
// SYSTEM ROLES ARE NOT EDITABLE HERE. Positions (the roles cloned
// from `ROLE_TEMPLATES` with `isSystem: true`) keep their
// template-managed permission sets — this preserves two invariants:
//   1. A position means the same thing in every org (auditors reason
//      about "Pharmacist" without diffing per-org drift).
//   2. Machine roles (WebhookService, NpiSyncWorker, …) stay
//      least-privilege; an admin cannot bolt extra permissions onto
//      a service identity. Custom needs get a custom role instead.
//
// Cache note: a permission-set change silently changes the effective
// access of EVERY current holder of the role. The output carries
// `affectedUserIds` so the dispatch route can drop each holder's
// operator-permission cache entry; the cache's 30s TTL is the
// safety net if that best-effort pass misses.
//
// Permission: `roles.manage` (ORGANIZATION scope).
//
// PHI: none. Role identifiers + permission codes only.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { isPermissionCode, PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const UPDATE_ROLE_PERMISSIONS_ROLE_NOT_FOUND = "UPDATE_ROLE_PERMISSIONS_ROLE_NOT_FOUND";
export const UPDATE_ROLE_PERMISSIONS_ROLE_IS_SYSTEM = "UPDATE_ROLE_PERMISSIONS_ROLE_IS_SYSTEM";
export const UPDATE_ROLE_PERMISSIONS_UNKNOWN_PERMISSION =
  "UPDATE_ROLE_PERMISSIONS_UNKNOWN_PERMISSION";
export const UPDATE_ROLE_PERMISSIONS_NOT_SEEDED = "UPDATE_ROLE_PERMISSIONS_NOT_SEEDED";

const inputSchema = z
  .object({
    roleId: z.uuid(),
    /**
     * The complete desired permission-code set. MAY be empty — an
     * admin can strip a custom role down to nothing before retiring
     * it (grants remain but stop conferring access).
     */
    permissions: z.array(z.string().trim().min(1).max(128)).max(200),
  })
  .strict();

export type UpdateRolePermissionsInput = z.infer<typeof inputSchema>;

export interface UpdateRolePermissionsOutput {
  readonly roleId: string;
  readonly code: string;
  readonly addedPermissions: ReadonlyArray<string>;
  readonly removedPermissions: ReadonlyArray<string>;
  readonly permissionCount: number;
  /** Every user currently holding the role — for cache invalidation. */
  readonly affectedUserIds: ReadonlyArray<string>;
}

export const UpdateRolePermissions: Command<
  UpdateRolePermissionsInput,
  UpdateRolePermissionsOutput
> = {
  name: "UpdateRolePermissions",
  inputSchema,
  permission: PERMISSIONS.ROLES_MANAGE,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
  }): Promise<HandlerResult<UpdateRolePermissionsOutput>> {
    const role = await tx.role.findFirst({
      where: { id: input.roleId, organizationId: ctx.organizationId },
      select: { id: true, code: true, isSystem: true },
    });
    if (role === null) {
      throw new errors.NotFoundError({
        code: UPDATE_ROLE_PERMISSIONS_ROLE_NOT_FOUND,
        message: "Role not found in this organization.",
        metadata: { roleId: input.roleId },
      });
    }
    if (role.isSystem) {
      throw new errors.ConflictError({
        code: UPDATE_ROLE_PERMISSIONS_ROLE_IS_SYSTEM,
        message: `Role "${role.code}" is a system position; its permission set is template-managed. Create a custom role instead.`,
        metadata: { roleId: input.roleId, code: role.code },
      });
    }

    const desired = [...new Set(input.permissions)];
    const unknown = desired.filter((c) => !isPermissionCode(c));
    if (unknown.length > 0) {
      throw new errors.ValidationError({
        code: UPDATE_ROLE_PERMISSIONS_UNKNOWN_PERMISSION,
        message: `Unrecognized permission code(s): ${unknown.join(", ")}.`,
        metadata: { unknown },
      });
    }

    const desiredRows =
      desired.length > 0
        ? await tx.permission.findMany({
            where: { code: { in: desired } },
            select: { id: true, code: true },
          })
        : [];
    if (desiredRows.length !== desired.length) {
      const seeded = new Set(desiredRows.map((r) => r.code));
      const missing = desired.filter((c) => !seeded.has(c));
      throw new errors.InternalError({
        code: UPDATE_ROLE_PERMISSIONS_NOT_SEEDED,
        message: `Permission code(s) recognized by the registry but missing from the database: ${missing.join(", ")}. Run the seed.`,
        metadata: { missing },
      });
    }

    const current = await tx.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permissionId: true, permission: { select: { code: true } } },
    });
    const currentByCode = new Map(current.map((r) => [r.permission.code, r.permissionId]));
    const desiredCodes = new Set(desired);

    const added = desiredRows.filter((r) => !currentByCode.has(r.code));
    const removed = current.filter((r) => !desiredCodes.has(r.permission.code));

    if (removed.length > 0) {
      await tx.rolePermission.deleteMany({
        where: { roleId: role.id, permissionId: { in: removed.map((r) => r.permissionId) } },
      });
    }
    if (added.length > 0) {
      await tx.rolePermission.createMany({
        data: added.map((p) => ({ roleId: role.id, permissionId: p.id })),
      });
    }

    const holders = await tx.userRole.findMany({
      where: { roleId: role.id },
      select: { userId: true },
      distinct: ["userId"],
    });
    const affectedUserIds = holders.map((h) => h.userId);

    const addedCodes = added.map((p) => p.code);
    const removedCodes = removed.map((r) => r.permission.code);

    return {
      output: Object.freeze({
        roleId: role.id,
        code: role.code,
        addedPermissions: Object.freeze(addedCodes),
        removedPermissions: Object.freeze(removedCodes),
        permissionCount: desired.length,
        affectedUserIds: Object.freeze(affectedUserIds),
      }),
      audit: {
        action: "org.role.permissions_updated",
        resourceType: "Role",
        resourceId: role.id,
        metadata: {
          code: role.code,
          addedPermissions: addedCodes,
          removedPermissions: removedCodes,
          permissionCount: desired.length,
          affectedUserCount: affectedUserIds.length,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.role.permissions_updated.v1",
          aggregateType: "Role",
          aggregateId: role.id,
          payload: {
            organizationId: ctx.organizationId,
            roleId: role.id,
            code: role.code,
            addedPermissions: addedCodes,
            removedPermissions: removedCodes,
            permissionCount: desired.length,
            affectedUserCount: affectedUserIds.length,
            occurredAt: new Date().toISOString(),
          },
        },
      ],
    };
  },
};
