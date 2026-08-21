// provider.credential.revoked.v1 — a prescriber's DEA registration or
// state licence was revoked or suspended.
//
// Producer: `RevokeProviderCredential` (`@pharmax/providers`).
// Consumers: security and compliance feeds — this is the event that
//   says a prescriber can no longer write what they could yesterday.
//
// ONE EVENT FOR BOTH CREDENTIAL KINDS, discriminated by `credentialKind`,
// because every consumer cares about the same thing: authority was
// withdrawn. A DEA-specific and a licence-specific event would each
// need subscribing to separately, and the consumer that forgot the
// second one would silently miss half the revocations.
//
// The reason is carried in the payload rather than left to the audit
// row. "Why did this prescriber lose authority" is asked months later,
// and a board action reads very differently from a clerical correction.
//
// PHI: none. `reason` is operator-authored text about a professional
// credential and must not describe a patient — reviewer-enforced,
// length-capped by the command.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const CREDENTIAL_KINDS = ["DEA_REGISTRATION", "STATE_LICENSE"] as const;
const CREDENTIAL_STATUSES = ["REVOKED", "SUSPENDED"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    credentialId: z.uuid(),
    credentialKind: z.enum(CREDENTIAL_KINDS),
    providerId: z.uuid(),
    npi: z.string().regex(/^\d{10}$/),
    /** STATE_LICENSE only; null for a DEA registration. */
    state: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    toStatus: z.enum(CREDENTIAL_STATUSES),
    reason: z.string().min(1).max(500),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderCredentialRevokedV1 = defineEvent({
  name: "provider.credential.revoked",
  version: 1,
  aggregateType: "Provider",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.providerId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.credentials",
  description:
    "Emitted when a prescriber's DEA registration or state licence is revoked or suspended. One event for both kinds, discriminated by credentialKind, so a consumer cannot subscribe to half the revocations by accident. Carries the reason; never the credential number.",
});

export type ProviderCredentialRevokedV1Payload = z.infer<typeof payloadSchema>;
