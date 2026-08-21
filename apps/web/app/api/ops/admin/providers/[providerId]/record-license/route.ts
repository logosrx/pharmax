// POST /api/ops/admin/providers/[providerId]/record-license
//
// Record or renew a prescriber's state licence to practise. Not
// MFA-gated: a state licence does not by itself authorize controlled
// prescribing, and this is routine credentialing data entry. The DEA
// route beside it is gated because that one decides Schedule II.

import { CredentialVerificationMethod } from "@pharmax/database";
import { RecordProviderStateLicense } from "@pharmax/providers";

import { dispatchOpsCommand } from "@/server/ops/dispatch-from-route";
import { readEnumField, readStringField } from "@/server/ops/read-body-field";

interface RouteParams {
  readonly params: Promise<{ readonly providerId: string }>;
}

const VERIFICATION_METHODS = [
  CredentialVerificationMethod.ATTESTED,
  CredentialVerificationMethod.PORTAL_CHECKED,
  CredentialVerificationMethod.REGISTRY_FILE,
] as const;

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { providerId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: RecordProviderStateLicense,
    idempotencyKeyPrefix: `route:record-license:${providerId}:${Date.now()}`,
    buildInput: ({ body }) => {
      const state = readStringField(body, "state");
      const licenseNumber = readStringField(body, "licenseNumber");
      const licenseType = readStringField(body, "licenseType");
      const issuedAt = readStringField(body, "issuedAt");
      const expiresAt = readStringField(body, "expiresAt");
      const verificationMethod = readEnumField(body, "verificationMethod", VERIFICATION_METHODS);

      if (state === null) return { error: "Select the issuing state." };
      if (licenseNumber === null) return { error: "A licence number is required." };
      return {
        providerId,
        state,
        licenseNumber,
        ...(licenseType === null ? {} : { licenseType }),
        ...(issuedAt === null ? {} : { issuedAt }),
        ...(expiresAt === null ? {} : { expiresAt }),
        ...(verificationMethod === null ? {} : { verificationMethod }),
      };
    },
    successRedirect: (output) =>
      `/ops/admin/providers/${providerId}?flash=${encodeURIComponent(
        output.renewed ? `${output.state} licence renewed.` : `${output.state} licence recorded.`
      )}`,
    failureRedirect: `/ops/admin/providers/${providerId}`,
    successLogEvent: "ops.admin.provider.record_license.applied",
    failureLogEvent: "ops.admin.provider.record_license.failed",
  });
}
