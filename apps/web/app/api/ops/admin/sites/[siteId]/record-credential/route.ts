// POST /api/ops/admin/sites/[siteId]/record-credential
//
// Record or renew one of the pharmacy's OWN regulatory credentials —
// go-live G-1. MFA-gated: this is the tenant asserting which licences
// it holds, and a state pharmacy licence recorded here is what
// ship-to-state authorization is derived from.

import { CredentialVerificationMethod, SiteCredentialKind } from "@pharmax/database";
import { RecordSiteCredential } from "@pharmax/orgs";

import { dispatchOpsCommandWithMfa } from "@/server/auth/dispatch-ops-with-mfa";
import { readEnumField, readStringField } from "@/server/ops/read-body-field";

interface RouteParams {
  readonly params: Promise<{ readonly siteId: string }>;
}

const CREDENTIAL_KINDS = [
  SiteCredentialKind.STATE_PHARMACY_LICENSE,
  SiteCredentialKind.DEA_REGISTRATION,
  SiteCredentialKind.NPI,
  SiteCredentialKind.NCPDP,
  SiteCredentialKind.NABP,
] as const;

const VERIFICATION_METHODS = [
  CredentialVerificationMethod.ATTESTED,
  CredentialVerificationMethod.PORTAL_CHECKED,
  CredentialVerificationMethod.REGISTRY_FILE,
] as const;

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { siteId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: RecordSiteCredential,
    idempotencyKeyPrefix: `route:record-site-credential:${siteId}:${Date.now()}`,
    buildInput: ({ body }) => {
      const kind = readEnumField(body, "kind", CREDENTIAL_KINDS);
      const identifier = readStringField(body, "identifier");
      const state = readStringField(body, "state");
      const issuedAt = readStringField(body, "issuedAt");
      const expiresAt = readStringField(body, "expiresAt");
      const verificationMethod = readEnumField(body, "verificationMethod", VERIFICATION_METHODS);

      if (kind === null) return { error: "Choose a credential kind." };
      if (identifier === null) return { error: "The credential number is required." };
      return {
        siteId,
        kind,
        identifier,
        // Passed through only when supplied. The command refuses a state
        // on a non-licence kind and requires one on a licence, so
        // dropping an empty string here keeps that error legible.
        ...(state === null ? {} : { state }),
        ...(issuedAt === null ? {} : { issuedAt }),
        ...(expiresAt === null ? {} : { expiresAt }),
        ...(verificationMethod === null ? {} : { verificationMethod }),
      };
    },
    successRedirect: (output) =>
      `/ops/admin/sites/${siteId}?flash=${encodeURIComponent(
        output.renewed ? "Credential renewed." : "Credential recorded."
      )}`,
    failureRedirect: `/ops/admin/sites/${siteId}`,
    successLogEvent: "ops.admin.site.record_credential.applied",
    failureLogEvent: "ops.admin.site.record_credential.failed",
  });
}
