// POST /api/ops/admin/users/:userId/revoke-role
//
// Admin action: remove a role grant from a user. Dispatches
// `RevokeUserRole`. The `:userId` path segment is for URL
// readability and audit context — the command identifies the
// grant by `userRoleId` posted in the body.
// RBAC enforced by the command (`roles.manage`).

import { RevokeUserRole } from "@pharmax/orgs";

import { dispatchOpsCommandWithMfa } from "../../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

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
    command: RevokeUserRole,
    idempotencyKeyPrefix: `route:revoke-role:${userId}`,
    buildInput: ({ body }) => {
      const userRoleId = readString(body, "userRoleId");
      if (userRoleId === null) return { error: "userRoleId is required." };
      return { userRoleId };
    },
    successRedirect: () => `/ops/admin/users?flash=${encodeURIComponent("Role revoked.")}`,
    failureRedirect: `/ops/admin/users`,
    successLogEvent: "ops.admin.user.revoke_role.applied",
    failureLogEvent: "ops.admin.user.revoke_role.failed",
  });
}
