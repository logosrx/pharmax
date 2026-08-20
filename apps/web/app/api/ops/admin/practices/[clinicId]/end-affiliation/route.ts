// POST /api/ops/admin/practices/[clinicId]/end-affiliation
//
// Admin action: withdraw a prescriber's authority to write for this
// client. Requires a reason, and revokes that prescriber's portal
// sessions for this client in the same transaction.
//
// The flash reports the revoked count: signing someone out mid-session
// is a visible consequence, and the operator who caused it should not
// have to infer it from a support ticket.

import { EndProviderClinicAffiliation } from "@pharmax/orgs";

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
    command: EndProviderClinicAffiliation,
    idempotencyKeyPrefix: `route:end-affiliation:${clinicId}:${Date.now()}`,
    buildInput: ({ body }) => {
      const providerId = readString(body, "providerId");
      const reason = readString(body, "reason");
      if (providerId === null) return { error: "Prescriber is required." };
      if (reason === null) return { error: "A reason is required to end access." };
      return { clinicId, providerId, reason };
    },
    successRedirect: (output) => {
      const revoked = output.revokedPortalSessionCount;
      const suffix =
        revoked === 0 ? "" : ` ${revoked} portal session${revoked === 1 ? "" : "s"} revoked.`;
      return `/ops/admin/practices/${clinicId}?flash=${encodeURIComponent(
        `Prescriber access ended.${suffix}`
      )}`;
    },
    failureRedirect: `/ops/admin/practices/${clinicId}`,
    successLogEvent: "ops.admin.clinic.end_affiliation.applied",
    failureLogEvent: "ops.admin.clinic.end_affiliation.failed",
  });
}
