// shipping.carrier_credential.registered.v1 — per-tenant carrier credential added or rotated.
//
// Producer: `RegisterCarrierCredential` (`@pharmax/shipping`).
// Consumers: shipping-adapter cache invalidation; SOC 2
//   credential-rotation audit feed.
//
// PHI: none. The credential SECRET (API key, webhook secret)
// stays in `@pharmax/crypto`-encrypted columns on the
// `carrier_credential` row and NEVER touches this payload.
// `hasWebhookSecret` is a presence boolean only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const SHIPPING_PROVIDERS = ["EASYPOST", "MANUAL"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    credentialId: z.uuid(),
    provider: z.enum(SHIPPING_PROVIDERS),
    /**
     * Id of the prior ACTIVE credential that this command
     * superseded — null when this is the first registration for
     * the provider. Surfacing the predecessor lets a rotation
     * audit feed plot the rotation cadence per tenant.
     */
    replacedCredentialId: z.uuid().nullable(),
    /**
     * `true` when the caller supplied a webhook signature secret
     * alongside the API key. The secret itself is encrypted on
     * the row and never appears in the payload.
     */
    hasWebhookSecret: z.boolean(),
  })
  .strict();

export const ShippingCarrierCredentialRegisteredV1 = defineEvent({
  name: "shipping.carrier_credential.registered",
  version: 1,
  aggregateType: "CarrierCredential",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.credentialId,
  owner: "shipping",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.shipping",
  description:
    "Emitted by RegisterCarrierCredential after a new carrier credential row is persisted. Drives shipping-adapter cache invalidation and the SOC 2 credential-rotation feed.",
});

export type ShippingCarrierCredentialRegisteredV1Payload = z.infer<typeof payloadSchema>;
