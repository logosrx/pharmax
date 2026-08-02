// provider.portal_account.password_changed.v1 — a prescriber rotated
// their portal credential (ADR-0033, slice 3). The portal twin of
// `user.password_changed.v1`.
//
// Producer: `ChangePortalPassword` (self-service; requires the
//   current password, so a hijacked session alone cannot produce
//   this event).
// Consumers: security anomaly feeds (a password change following a
//   burst of failed sign-ins is a takeover signal).
//
// PHI: none. Neither password nor any hash rides the payload.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    portalAccountId: z.uuid(),
    organizationId: z.uuid(),
    providerId: z.uuid(),
    /** Other sessions revoked by the change (the caller's own may survive). */
    sessionsRevoked: z.number().int().min(0),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderPortalAccountPasswordChangedV1 = defineEvent({
  name: "provider.portal_account.password_changed",
  version: 1,
  aggregateType: "PortalAccount",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.portalAccountId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.portal",
  description:
    "Emitted when a prescriber changes their portal password (current password verified; every other portal session revoked). No credential material in the payload.",
});

export type ProviderPortalAccountPasswordChangedV1Payload = z.infer<typeof payloadSchema>;
