// Per-org credential resolver — bridges `carrier_credential` rows
// to configured `ShippingAdapter` instances.
//
// Lookup flow:
//   1. Read the ACTIVE `carrier_credential` row for (org, provider).
//      The Prisma tenancy extension auto-injects `organizationId`,
//      so a cross-tenant credential is invisible at the read layer
//      and the underlying RLS policy enforces the same boundary.
//   2. Decrypt the API key (and webhook secret if present) via
//      `@pharmax/crypto` with the canonical AAD binding
//      `{tenantId: organizationId, table: "carrier_credential",
//       column: "<apiKey|webhookSecret>", recordId: credential.id}`.
//      A ciphertext moved between rows fails decrypt with
//      AuthorizationError(AAD_MISMATCH) — defense in depth on top
//      of RLS.
//   3. Hand the plaintext credentials to the provider's factory
//      (registered via `configureShipping`) and return the adapter.
//
// Caching: this function decrypts on every call. Per-tx caching is
// the caller's responsibility; per-process caching with envelope-
// kid invalidation can be added when carrier API latency becomes
// the bottleneck.

import type { PrismaTxClient } from "@pharmax/command-bus";
import { decryptField } from "@pharmax/crypto";
import { CarrierCredentialStatus, type ShippingProvider } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

import type { ShippingAdapter } from "./carriers/shipping-adapter.js";
import { getShippingAdapterFactory, type CarrierCredentialContext } from "./configure.js";

export const SHIPPING_CREDENTIAL_NOT_FOUND = "SHIPPING_CREDENTIAL_NOT_FOUND";

export interface ResolveShippingAdapterInput {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly provider: ShippingProvider;
}

export interface ResolvedShippingAdapter {
  readonly adapter: ShippingAdapter;
  readonly credentialId: string;
}

/**
 * Resolve the ACTIVE credential for (organizationId, provider),
 * decrypt the API key and webhook secret, and build the adapter via
 * the configured factory.
 *
 * Throws `NotFoundError(SHIPPING_CREDENTIAL_NOT_FOUND)` if no
 * ACTIVE credential exists. The command should surface this as a
 * 404 / "provider not configured for this org" — admins fix it via
 * `RegisterCarrierCredential`.
 */
export async function resolveShippingAdapter(
  input: ResolveShippingAdapterInput
): Promise<ResolvedShippingAdapter> {
  const credential = await input.tx.carrierCredential.findFirst({
    where: {
      organizationId: input.organizationId,
      provider: input.provider,
      status: CarrierCredentialStatus.ACTIVE,
    },
    select: {
      id: true,
      apiKeyEnc: true,
      webhookSecretEnc: true,
      carrierAccountId: true,
      baseUrl: true,
    },
  });
  if (credential === null) {
    throw new errors.NotFoundError({
      code: SHIPPING_CREDENTIAL_NOT_FOUND,
      message: `No ACTIVE carrier credential is registered for provider ${input.provider}.`,
      metadata: {
        organizationId: input.organizationId,
        provider: input.provider,
      },
    });
  }

  const [apiKey, webhookSecret] = await Promise.all([
    decryptField({
      envelope: credential.apiKeyEnc,
      binding: {
        tenantId: input.organizationId,
        table: "carrier_credential",
        column: "apiKey",
        recordId: credential.id,
      },
    }),
    credential.webhookSecretEnc === null || credential.webhookSecretEnc === undefined
      ? Promise.resolve(null)
      : decryptField({
          envelope: credential.webhookSecretEnc,
          binding: {
            tenantId: input.organizationId,
            table: "carrier_credential",
            column: "webhookSecret",
            recordId: credential.id,
          },
        }),
  ]);

  const ctx: CarrierCredentialContext = {
    organizationId: input.organizationId,
    credentialId: credential.id,
    apiKey,
    webhookSecret,
    carrierAccountId: credential.carrierAccountId,
    baseUrl: credential.baseUrl,
  };

  const factory = getShippingAdapterFactory(input.provider);
  return Object.freeze({ adapter: factory(ctx), credentialId: credential.id });
}
