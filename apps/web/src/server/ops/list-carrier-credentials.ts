// Carrier-credential admin projection — drives `/ops/admin/carriers`.
//
// Returns one row per registered credential (ACTIVE + DISABLED so
// the operator can see rotation history). NEVER decrypts the API
// key or webhook secret — those are write-only from the admin
// surface. Once registered, the key material is invisible to
// operators; rotation is "register a new ACTIVE key, the prior
// one is auto-DISABLED" by the command.

import "server-only";

import { prisma, type CarrierCredentialStatus, type ShippingProvider } from "@pharmax/database";

export interface CarrierCredentialRow {
  readonly credentialId: string;
  readonly provider: ShippingProvider;
  readonly status: CarrierCredentialStatus;
  readonly carrierAccountId: string | null;
  readonly baseUrl: string | null;
  readonly notes: string | null;
  /** True iff the registered credential included a webhook secret. */
  readonly hasWebhookSecret: boolean;
  readonly createdByUserId: string;
  readonly createdAt: Date;
}

export async function listCarrierCredentials(input: {
  readonly organizationId: string;
}): Promise<ReadonlyArray<CarrierCredentialRow>> {
  const rows = await prisma.carrierCredential.findMany({
    where: { organizationId: input.organizationId },
    select: {
      id: true,
      provider: true,
      status: true,
      carrierAccountId: true,
      baseUrl: true,
      notes: true,
      webhookSecretEnc: true,
      createdByUserId: true,
      createdAt: true,
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  return rows.map((r) =>
    Object.freeze({
      credentialId: r.id,
      provider: r.provider,
      status: r.status,
      carrierAccountId: r.carrierAccountId,
      baseUrl: r.baseUrl,
      notes: r.notes,
      // JSON envelope columns are non-null when a secret was
      // registered. We compare against `null` rather than reading
      // the envelope shape because we never want to decrypt here.
      hasWebhookSecret: r.webhookSecretEnc !== null,
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt,
    })
  );
}

/**
 * Returns the providers for which an ACTIVE credential is
 * configured. Used by the auto-purchase shipping form to gate the
 * provider dropdown to only providers the org can actually call.
 */
export async function listActiveProviders(input: {
  readonly organizationId: string;
}): Promise<ReadonlyArray<ShippingProvider>> {
  const rows = await prisma.carrierCredential.findMany({
    where: { organizationId: input.organizationId, status: "ACTIVE" },
    select: { provider: true },
    orderBy: { provider: "asc" },
  });
  return rows.map((r) => r.provider);
}
