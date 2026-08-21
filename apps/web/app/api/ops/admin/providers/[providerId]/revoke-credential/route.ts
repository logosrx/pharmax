// POST /api/ops/admin/providers/[providerId]/revoke-credential
//
// Withdraw a prescriber's DEA registration or state licence. MFA-gated:
// revoking a DEA registration stops controlled prescribing immediately,
// and revoking the wrong one is disruptive in a way a name correction
// is not.
//
// One route for both credential kinds, matching the command. A route
// per model would duplicate the reason-code plumbing for no gain.

import { CredentialStatus } from "@pharmax/database";
import { PROVIDER_CREDENTIAL_KINDS, RevokeProviderCredential } from "@pharmax/providers";

import { dispatchOpsCommandWithMfa } from "@/server/auth/dispatch-ops-with-mfa";
import { readEnumField, readStringField } from "@/server/ops/read-body-field";

interface RouteParams {
  readonly params: Promise<{ readonly providerId: string }>;
}

/** The two statuses a credential may be withdrawn INTO. */
const WITHDRAWAL_TARGETS = [CredentialStatus.REVOKED, CredentialStatus.SUSPENDED] as const;

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { providerId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: RevokeProviderCredential,
    idempotencyKeyPrefix: `route:revoke-credential:${providerId}:${Date.now()}`,
    buildInput: ({ body }) => {
      const credentialKind = readEnumField(body, "credentialKind", PROVIDER_CREDENTIAL_KINDS);
      const credentialId = readStringField(body, "credentialId");
      const toStatus = readEnumField(body, "toStatus", WITHDRAWAL_TARGETS);
      const reason = readStringField(body, "reason");

      if (credentialKind === null) return { error: "Unknown credential kind." };
      if (credentialId === null) return { error: "Credential is required." };
      if (toStatus === null) {
        return { error: "Choose whether this is a revocation or a suspension." };
      }
      if (reason === null) return { error: "A reason is required to withdraw a credential." };
      return { credentialKind, credentialId, toStatus, reason };
    },
    successRedirect: (output) =>
      `/ops/admin/providers/${providerId}?flash=${encodeURIComponent(
        `Credential ${output.toStatus.toLowerCase()}.`
      )}`,
    failureRedirect: `/ops/admin/providers/${providerId}`,
    successLogEvent: "ops.admin.provider.revoke_credential.applied",
    failureLogEvent: "ops.admin.provider.revoke_credential.failed",
  });
}
