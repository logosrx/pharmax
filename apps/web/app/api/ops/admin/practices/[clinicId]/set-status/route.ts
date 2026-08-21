// POST /api/ops/admin/practices/[clinicId]/set-status
//
// Admin action: deactivate, reactivate, or archive a client practice.
//
// Not a plain status flip. Deactivating revokes every provider-portal
// session still acting for this client, so prescribers are signed out
// of it in the same transaction. The flash message reports the count
// because that is the part an operator would not otherwise see.

import { ClinicStatus } from "@pharmax/database";
import { SetClinicStatus } from "@pharmax/orgs";

import { dispatchOpsCommandWithMfa } from "../../../../../../../src/server/auth/dispatch-ops-with-mfa.js";

interface RouteParams {
  readonly params: Promise<{ readonly clinicId: string }>;
}

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Narrow the posted status to the enum at the transport edge. The
 * command's Zod schema would reject an unknown value anyway, but that
 * would surface as a generic input error; naming the field here gives
 * the operator a message about the thing they actually chose.
 */
function readStatus(body: FormData | Record<string, unknown>): ClinicStatus | null {
  const raw = readString(body, "status");
  if (raw === null) return null;
  return Object.values(ClinicStatus).includes(raw as ClinicStatus) ? (raw as ClinicStatus) : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { clinicId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: SetClinicStatus,
    idempotencyKeyPrefix: `route:set-clinic-status:${clinicId}:${Date.now()}`,
    buildInput: ({ body }) => {
      const status = readStatus(body);
      const reason = readString(body, "reason");
      if (status === null) return { error: "Select a valid target status." };
      if (reason === null) return { error: "A reason is required." };
      return { clinicId, status, reason };
    },
    successRedirect: (output) => {
      const revoked = output.revokedPortalSessionCount;
      const suffix =
        revoked === 0
          ? ""
          : ` ${revoked} provider-portal session${revoked === 1 ? "" : "s"} revoked.`;
      return `/ops/admin/practices/${clinicId}?flash=${encodeURIComponent(
        `${output.code} is now ${output.toStatus}.${suffix}`
      )}`;
    },
    failureRedirect: `/ops/admin/practices/${clinicId}`,
    successLogEvent: "ops.admin.clinic.set_status.applied",
    failureLogEvent: "ops.admin.clinic.set_status.failed",
  });
}
