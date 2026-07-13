// POST /api/ops/admin/users/invite
//
// Admin action: invite a teammate by email. Dispatches `InviteUser`
// (creates the INVITED row; RBAC `users.manage` enforced by the
// command), then — post-commit — issues a credential-setup token and
// delivers the accept-invite link via the mailer port (ADR-0030).

import { issueInvite } from "@pharmax/auth";
import { InviteUser } from "@pharmax/orgs";

import { dispatchOpsCommandWithMfa } from "../../../../../../src/server/auth/dispatch-ops-with-mfa.js";
import { notificationPasswordResetMailer } from "../../../../../../src/server/auth/password-reset-mailer.js";

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
    // Post-commit: mint the setup token + deliver the accept-invite
    // link. Best-effort — a delivery failure does not undo the invite
    // (the admin can resend). Skipped for a redundant re-invite.
    onSuccess: async ({ output, organizationId }) => {
      if (output.userAlreadyExists) return;
      const issued = await issueInvite({ userId: output.userId, organizationId });
      await notificationPasswordResetMailer.sendPasswordReset({
        kind: "invite",
        email: output.email,
        displayName: output.email,
        rawToken: issued.rawToken,
        expiresAt: issued.expiresAt,
        organizationId,
        userId: output.userId,
      });
    },
    successRedirect: (output) =>
      output.userAlreadyExists
        ? `/ops/admin/users?flash=${encodeURIComponent(`Already invited: ${output.email}`)}`
        : `/ops/admin/users?flash=${encodeURIComponent(
            `Invite sent to ${output.email}. They'll set a password from the link.`
          )}`,
    failureRedirect: `/ops/admin/users`,
    successLogEvent: "ops.admin.user.invite.applied",
    failureLogEvent: "ops.admin.user.invite.failed",
  });
}
