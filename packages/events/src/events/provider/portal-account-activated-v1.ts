// provider.portal_account.activated.v1 — a prescriber consumed the
// one-time setup link and set their portal password (ADR-0033,
// slice 2). PENDING_SETUP → ACTIVE.
//
// Producer: `SetupPortalAccount` (pre-auth system command; the
//   caller holds only the emailed token).
// Consumers: onboarding funnel reporting (applied → approved →
//   activated conversion); ops visibility.
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    portalAccountId: z.uuid(),
    organizationId: z.uuid(),
    providerId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderPortalAccountActivatedV1 = defineEvent({
  name: "provider.portal_account.activated",
  version: 1,
  aggregateType: "PortalAccount",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.portalAccountId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.portal",
  description:
    "Emitted when a prescriber consumes their one-time setup token and sets the initial portal password, activating the PENDING_SETUP portal account.",
});

export type ProviderPortalAccountActivatedV1Payload = z.infer<typeof payloadSchema>;
