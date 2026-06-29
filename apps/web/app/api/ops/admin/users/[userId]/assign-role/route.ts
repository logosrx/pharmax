// POST /api/ops/admin/users/:userId/assign-role
//
// Admin action: grant a role to a user. Dispatches `AssignRole`.
// RBAC enforced by the command (`roles.manage`). Scope rules
// (ORG vs SITE vs CLINIC vs TEAM) are enforced by the command;
// the form posts whatever the admin chose and the typed error
// codes (ASSIGN_ROLE_SCOPE_REQUIRES_SITE, etc.) surface as flash
// errors.

import { AssignRole } from "@pharmax/orgs";

import { dispatchOpsCommandWithMfa } from "../../../../../../../src/server/auth/dispatch-ops-with-mfa.js";
import { invalidateOperatorPermissionCache } from "../../../../../../../src/server/auth/operator-permission-cache.js";

interface RouteParams {
  readonly params: Promise<{ readonly userId: string }>;
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { userId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: AssignRole,
    idempotencyKeyPrefix: `route:assign-role:${userId}`,
    buildInput: ({ body }) => {
      const roleCode = readString(body, "roleCode");
      if (roleCode === null) return { error: "roleCode is required." };
      const siteId = readString(body, "siteId");
      const clinicId = readString(body, "clinicId");
      const teamId = readString(body, "teamId");
      return {
        userId,
        roleCode,
        ...(siteId !== null ? { siteId } : {}),
        ...(clinicId !== null ? { clinicId } : {}),
        ...(teamId !== null ? { teamId } : {}),
      };
    },
    // Drop the target user's cached grants so the new role takes effect
    // immediately (not after the TTL). `userId` is the grant target.
    onSuccess: ({ organizationId }) => invalidateOperatorPermissionCache(organizationId, userId),
    successRedirect: () => `/ops/admin/users?flash=${encodeURIComponent("Role granted.")}`,
    failureRedirect: `/ops/admin/users`,
    successLogEvent: "ops.admin.user.assign_role.applied",
    failureLogEvent: "ops.admin.user.assign_role.failed",
  });
}
