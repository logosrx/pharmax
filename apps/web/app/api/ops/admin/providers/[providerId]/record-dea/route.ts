// POST /api/ops/admin/providers/[providerId]/record-dea
//
// Record or renew a prescriber's DEA registration. MFA-gated: this
// decides whether controlled prescriptions may be written.
//
// Schedules arrive as a repeated checkbox group and an empty group is
// refused here. The command has no default schedule set, deliberately —
// silently granting Schedule II because a field was left blank is the
// mistake most worth designing out.

import { ControlledSubstanceSchedule, CredentialVerificationMethod } from "@pharmax/database";
import { RecordProviderDeaRegistration } from "@pharmax/providers";

import { dispatchOpsCommandWithMfa } from "@/server/auth/dispatch-ops-with-mfa";
import { readEnumField, readEnumListField, readStringField } from "@/server/ops/read-body-field";

interface RouteParams {
  readonly params: Promise<{ readonly providerId: string }>;
}

/** Controlled schedules only; the command refuses NON_CONTROLLED. */
const CONTROLLED_SCHEDULES = [
  ControlledSubstanceSchedule.CII,
  ControlledSubstanceSchedule.CIII,
  ControlledSubstanceSchedule.CIV,
  ControlledSubstanceSchedule.CV,
] as const;

const VERIFICATION_METHODS = [
  CredentialVerificationMethod.ATTESTED,
  CredentialVerificationMethod.PORTAL_CHECKED,
  CredentialVerificationMethod.REGISTRY_FILE,
] as const;

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { providerId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: RecordProviderDeaRegistration,
    idempotencyKeyPrefix: `route:record-dea:${providerId}:${Date.now()}`,
    buildInput: ({ body }) => {
      const deaNumber = readStringField(body, "deaNumber");
      const authorizedSchedules = readEnumListField(
        body,
        "authorizedSchedules",
        CONTROLLED_SCHEDULES
      );
      const issuedState = readStringField(body, "issuedState");
      const issuedAt = readStringField(body, "issuedAt");
      const expiresAt = readStringField(body, "expiresAt");
      const verificationMethod = readEnumField(body, "verificationMethod", VERIFICATION_METHODS);

      if (deaNumber === null) return { error: "A DEA number is required." };
      if (authorizedSchedules.length === 0) {
        return { error: "Select at least one controlled schedule this registration authorizes." };
      }
      return {
        providerId,
        deaNumber,
        authorizedSchedules: [...authorizedSchedules],
        ...(issuedState === null ? {} : { issuedState }),
        ...(issuedAt === null ? {} : { issuedAt }),
        ...(expiresAt === null ? {} : { expiresAt }),
        ...(verificationMethod === null ? {} : { verificationMethod }),
      };
    },
    successRedirect: (output) =>
      `/ops/admin/providers/${providerId}?flash=${encodeURIComponent(
        output.renewed ? "DEA registration renewed." : "DEA registration recorded."
      )}`,
    failureRedirect: `/ops/admin/providers/${providerId}`,
    successLogEvent: "ops.admin.provider.record_dea.applied",
    failureLogEvent: "ops.admin.provider.record_dea.failed",
  });
}
