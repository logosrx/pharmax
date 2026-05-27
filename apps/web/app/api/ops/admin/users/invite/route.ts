// POST /api/ops/admin/users/invite
//
// Admin action: invite a teammate by email. Dispatches `InviteUser`.
// RBAC enforced by the command (`users.manage`).

import { InviteUser } from "@pharmax/orgs";

import { dispatchOpsCommandWithMfa } from "../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request): Promise<Response> {
  return await dispatchOpsCommandWithMfa({
    request,
    command: InviteUser,
    idempotencyKeyPrefix: `route:invite-user:${Date.now()}`,
    buildInput: ({ body }) => {
      const email = readString(body, "email");
      const displayName = readString(body, "displayName");
      if (email === null) return { error: "email is required." };
      if (displayName === null) return { error: "displayName is required." };
      return { email, displayName };
    },
    successRedirect: (output) =>
      output.userAlreadyExists
        ? `/ops/admin/users?flash=${encodeURIComponent(`Already invited: ${output.email}`)}`
        : `/ops/admin/users?flash=${encodeURIComponent(
            `Invite sent. ${output.email} will be linked on their first Clerk sign-in.`
          )}`,
    failureRedirect: `/ops/admin/users`,
    successLogEvent: "ops.admin.user.invite.applied",
    failureLogEvent: "ops.admin.user.invite.failed",
  });
}
