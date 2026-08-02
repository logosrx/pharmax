// provider.portal_account.signed_in.v1 — a prescriber signed in to
// the provider portal (ADR-0033, slice 2). The portal twin of
// `user.signed_in.v1`.
//
// Producer: `PortalSignIn` (success path only; failures never reach
//   the bus — they are recorded in the login_attempt ledger by the
//   `portalSignIn` orchestrator).
// Consumers: security anomaly feeds; portal engagement reporting.
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    portalAccountId: z.uuid(),
    organizationId: z.uuid(),
    providerId: z.uuid(),
    sessionId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderPortalAccountSignedInV1 = defineEvent({
  name: "provider.portal_account.signed_in",
  version: 1,
  aggregateType: "PortalAccount",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.portalAccountId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.portal",
  description:
    "Emitted on every successful provider-portal sign-in. Failed attempts never produce events; they are recorded in the login_attempt ledger.",
});

export type ProviderPortalAccountSignedInV1Payload = z.infer<typeof payloadSchema>;
