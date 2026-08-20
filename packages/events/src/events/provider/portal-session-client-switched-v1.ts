// provider.portal_session.client_switched.v1 — a prescriber changed
// which client practice their portal session is acting for.
//
// Producer: `SwitchPortalClinic` (`@pharmax/providers`).
// Consumers: security anomaly feeds; portal engagement reporting.
//
// Why this is an event at all, when "changed a dropdown" sounds
// cosmetic: the active client decides which orders the session can read
// and which client is invoiced for anything it produces. A switch is
// therefore a scope change on a live principal, and a security feed
// wants it for the same reason it wants a role grant.
//
// Both session ids are carried because the switch revokes and re-mints
// rather than editing scope in place. One token means one client for its
// whole life, which is what keeps "what scope did this request run
// under" answerable from a session id alone instead of by replaying
// every switch in order.
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    portalAccountId: z.uuid(),
    providerId: z.uuid(),
    /**
     * Revoked with SCOPE_CHANGED. Its clinic is null when the prior
     * session had not chosen yet — the first selection after a sign-in
     * with several affiliations.
     */
    fromSessionId: z.uuid(),
    fromClinicId: z.uuid().nullable(),
    /** The freshly minted, single-client-scoped session. */
    toSessionId: z.uuid(),
    toClinicId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProviderPortalSessionClientSwitchedV1 = defineEvent({
  name: "provider.portal_session.client_switched",
  version: 1,
  aggregateType: "PortalAccount",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.portalAccountId,
  owner: "providers",
  retention: "7y",
  phiSafe: true,
  routingKey: "provider.portal",
  description:
    "Emitted when a prescriber selects or changes the client practice their portal session acts for. A scope change on a live principal: the prior session is revoked with SCOPE_CHANGED and a new single-client session minted, and both ids are carried so a request's scope stays reconstructable from its session id.",
});

export type ProviderPortalSessionClientSwitchedV1Payload = z.infer<typeof payloadSchema>;
