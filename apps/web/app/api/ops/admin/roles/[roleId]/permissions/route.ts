// POST /api/ops/admin/roles/:roleId/permissions
//
// Admin action: replace a custom role's permission set. Dispatches
// `UpdateRolePermissions` (RBAC `roles.manage` enforced by the
// command; system positions rejected with a typed conflict; MFA
// floor enforced by the wrapper).
//
// Cache: a role-permission change alters the effective access of
// EVERY holder of the role, so on success we drop each holder's
// operator-permission cache entry (the command output carries
// `affectedUserIds`). Best-effort — the cache's 30s TTL bounds any
// missed invalidation.

import { UpdateRolePermissions } from "@pharmax/orgs";

import { dispatchOpsCommandWithMfa } from "../../../../../../../src/server/auth/dispatch-ops-with-mfa.js";
import { invalidateOperatorPermissionCache } from "../../../../../../../src/server/auth/operator-permission-cache.js";

interface RouteParams {
  readonly params: Promise<{ readonly roleId: string }>;
}

function readStringArray(body: FormData | Record<string, unknown>, key: string): string[] {
  if (body instanceof FormData) {
    return body
      .getAll(key)
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
  }
  const raw = (body as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { roleId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: UpdateRolePermissions,
    idempotencyKeyPrefix: `route:update-role-permissions:${roleId}`,
    buildInput: ({ body }) => ({
      roleId,
      // An all-unchecked matrix legitimately submits zero entries —
      // the command treats the empty set as "strip the role".
      permissions: readStringArray(body, "permissions"),
    }),
    onSuccess: async ({ output, organizationId }) => {
      await Promise.all(
        output.affectedUserIds.map((userId) =>
          invalidateOperatorPermissionCache(organizationId, userId)
        )
      );
    },
    successRedirect: (output) =>
      `/ops/admin/roles/${roleId}?flash=${encodeURIComponent(
        `Saved: ${output.addedPermissions.length} added, ${output.removedPermissions.length} removed (${output.permissionCount} total).`
      )}`,
    failureRedirect: `/ops/admin/roles/${roleId}`,
    successLogEvent: "ops.admin.role.update_permissions.applied",
    failureLogEvent: "ops.admin.role.update_permissions.failed",
  });
}
