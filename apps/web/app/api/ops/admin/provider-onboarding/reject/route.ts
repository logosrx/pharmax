// POST /api/ops/admin/provider-onboarding/reject
//
// Admin action: reject a NEEDS_REVIEW onboarding application.
// Dispatches `RejectProviderOnboardingApplication` (RBAC
// `providers.onboarding.review`; MFA floor by the wrapper). Every
// rejection carries the reviewer's user stamp and a reason code —
// there is no anonymous or automated rejection path anywhere in
// the onboarding pipeline.

import { RejectProviderOnboardingApplication } from "@pharmax/providers";

import { dispatchOpsCommandWithMfa } from "../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request): Promise<Response> {
  return await dispatchOpsCommandWithMfa({
    request,
    command: RejectProviderOnboardingApplication,
    idempotencyKeyPrefix: "route:reject-provider-onboarding",
    buildInput: ({ body }) => {
      const applicationId = readString(body, "applicationId");
      if (applicationId === null || !UUID_REGEX.test(applicationId)) {
        return { error: "applicationId is required." };
      }
      const reasonCode = readString(body, "reasonCode");
      if (reasonCode === null) {
        return { error: "A reason code is required to reject an application." };
      }
      return { applicationId, reasonCode };
    },
    successRedirect: () =>
      `/ops/admin/provider-onboarding?flash=${encodeURIComponent("Application rejected.")}`,
    failureRedirect: "/ops/admin/provider-onboarding",
    successLogEvent: "ops.admin.provider_onboarding.reject.applied",
    failureLogEvent: "ops.admin.provider_onboarding.reject.failed",
  });
}
