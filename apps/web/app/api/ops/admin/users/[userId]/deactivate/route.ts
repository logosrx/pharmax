// POST /api/ops/admin/users/:userId/deactivate
//
// Admin action: suspend or terminate an operator. Dispatches
// `DeactivateUser` (RBAC `users.manage`), which flips the user's status
// AND revokes all their active sessions in the same transaction — the
// in-house replacement for Clerk's off-boarding webhook (ADR-0030).

import { DeactivateUser } from "@pharmax/auth";

import { dispatchOpsCommandWithMfa } from "../../../../../../../src/server/auth/dispatch-ops-with-mfa.js";
import { invalidateOperatorIdentityCache } from "../../../../../../../src/server/auth/operator-identity-cache.js";
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
    command: DeactivateUser,
    idempotencyKeyPrefix: `route:deactivate-user:${userId}`,
    buildInput: ({ body }) => {
      const statusRaw = readString(body, "status");
      if (statusRaw !== "SUSPENDED" && statusRaw !== "TERMINATED") {
        return { error: "status must be SUSPENDED or TERMINATED." };
      }
      const status: "SUSPENDED" | "TERMINATED" = statusRaw;
      const reason = readString(body, "reason");
      return {
        targetUserId: userId,
        status,
        ...(reason !== null ? { reason } : {}),
      };
    },
    // Drop the target's cached identity + grants so the status change
    // takes effect immediately (not after the TTL). Sessions are already
    // revoked in the command's transaction.
    onSuccess: async ({ organizationId }) => {
      await invalidateOperatorIdentityCache(userId);
      await invalidateOperatorPermissionCache(organizationId, userId);
    },
    successRedirect: (output) =>
      `/ops/admin/users?flash=${encodeURIComponent(
        `User ${output.status.toLowerCase()} — ${output.sessionsRevoked} session(s) revoked.`
      )}`,
    failureRedirect: `/ops/admin/users`,
    successLogEvent: "ops.admin.user.deactivate.applied",
    failureLogEvent: "ops.admin.user.deactivate.failed",
  });
}
