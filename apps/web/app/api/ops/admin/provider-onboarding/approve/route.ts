// POST /api/ops/admin/provider-onboarding/approve
//
// Admin action: approve a NEEDS_REVIEW onboarding application.
// Dispatches `ApproveProviderOnboardingApplication` (RBAC
// `providers.onboarding.review` enforced by the command; MFA floor
// enforced by the wrapper). Approval creates the roster row — the
// reviewer is attesting to identity the NPPES check could not
// cleanly verify, so a reason code is mandatory.
//
// Post-commit (ADR-0033 slice 2): the approval also provisioned a
// PENDING_SETUP portal account; the onSuccess hook mints the
// one-time setup token and delivers the /portal/setup link via the
// mailer port — mirroring the user-invite route. Best-effort: a
// delivery failure never undoes the approval.

import { ApproveProviderOnboardingApplication, issuePortalSetupToken } from "@pharmax/providers";

import { dispatchOpsCommandWithMfa } from "../../../../../../src/server/auth/dispatch-ops-with-mfa.js";
import { portalSetupMailer } from "../../../../../../src/server/portal/setup-mailer.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request): Promise<Response> {
  return await dispatchOpsCommandWithMfa({
    request,
    command: ApproveProviderOnboardingApplication,
    idempotencyKeyPrefix: "route:approve-provider-onboarding",
    buildInput: ({ body }) => {
      const applicationId = readString(body, "applicationId");
      if (applicationId === null || !UUID_REGEX.test(applicationId)) {
        return { error: "applicationId is required." };
      }
      const reasonCode = readString(body, "reasonCode");
      if (reasonCode === null) {
        return { error: "A reason code is required to approve past a proofing mismatch." };
      }
      return { applicationId, reasonCode };
    },
    // Post-commit: mint the portal setup token + deliver the link.
    // Skipped when provisioning was skipped (email already taken by
    // another portal account — surfaced in the audit metadata).
    onSuccess: async ({ output, organizationId }) => {
      if (output.portalAccountId === null) return;
      const issued = await issuePortalSetupToken({
        portalAccountId: output.portalAccountId,
        organizationId,
      });
      await portalSetupMailer.sendPortalSetup({
        email: issued.email,
        displayName: issued.email,
        rawToken: issued.rawToken,
        expiresAt: issued.expiresAt,
        organizationId,
        portalAccountId: output.portalAccountId,
      });
    },
    successRedirect: (output) =>
      `/ops/admin/provider-onboarding?flash=${encodeURIComponent(
        `Application approved; provider ${output.providerId} added to the roster.`
      )}`,
    failureRedirect: "/ops/admin/provider-onboarding",
    successLogEvent: "ops.admin.provider_onboarding.approve.applied",
    failureLogEvent: "ops.admin.provider_onboarding.approve.failed",
  });
}
