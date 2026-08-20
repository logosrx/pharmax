// POST /api/ops/admin/practices/[clinicId]/affiliate-provider
//
// Admin action: grant a prescriber authority to write for this client.
//
// Not MFA-gated, unlike the client lifecycle routes. This is the
// everyday action — "the practice says Dr. Chen writes for them now" —
// and it is granted to PharmacyTechnician on the reasoning that a tech
// already registers prescribers outright, DEA number included. Putting
// an MFA prompt in front of routine data entry trains people to reach
// for their phone reflexively, which is worse for security than the
// prompt is good.

import { AffiliateProviderWithClinic } from "@pharmax/orgs";

import { dispatchOpsCommand } from "../../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly clinicId: string }>;
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { clinicId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: AffiliateProviderWithClinic,
    idempotencyKeyPrefix: `route:affiliate-provider:${clinicId}:${Date.now()}`,
    buildInput: ({ body }) => {
      const providerId = readString(body, "providerId");
      if (providerId === null) return { error: "Select a prescriber." };
      return { clinicId, providerId };
    },
    successRedirect: (output) =>
      `/ops/admin/practices/${clinicId}?flash=${encodeURIComponent(
        output.reactivated
          ? "Prescriber access restored for this client."
          : "Prescriber may now write for this client."
      )}`,
    failureRedirect: `/ops/admin/practices/${clinicId}`,
    successLogEvent: "ops.admin.clinic.affiliate_provider.applied",
    failureLogEvent: "ops.admin.clinic.affiliate_provider.failed",
  });
}
