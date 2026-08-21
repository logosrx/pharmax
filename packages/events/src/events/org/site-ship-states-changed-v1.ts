// org.site_ship_states.changed.v1 — the states a pharmacy site may
// dispense into were changed.
//
// Producer: `SetSiteAuthorizedShipStates` (`@pharmax/orgs`).
// Consumers: security and compliance feeds. This is the most
//   consequential configuration change in the platform: the set it
//   carries is the only thing preventing a prescription shipping into
//   a state the pharmacy holds no licence for, which is a finding
//   against the customer's licence rather than a software bug.
//
// Go-live G-2.
//
// Carries the full resulting set plus the added and removed deltas.
// The set answers "what is true now" without a join; the deltas answer
// "what just changed", and an alert on a state being ADDED is the one
// worth waking someone for.
//
// `enforcementActivated` marks the transition from an empty set to a
// non-empty one. Enforcement is off for a site that has declared
// nothing, so the first declaration is the moment refusals begin — and
// a tenant discovering that from a refused shipment rather than from
// this event is a support call.
//
// PHI: none.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const stateCode = z.string().regex(/^[A-Z]{2}$/);

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    siteId: z.uuid(),
    siteCode: z.string().min(1).max(64),
    /** The full resulting set, sorted, so consumers need no join. */
    states: z.array(stateCode),
    addedStates: z.array(stateCode),
    removedStates: z.array(stateCode),
    /** True when this change took the site from unenforced to enforced. */
    enforcementActivated: z.boolean(),
    reason: z.string().min(1).max(500),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgSiteShipStatesChangedV1 = defineEvent({
  name: "org.site_ship_states.changed",
  version: 1,
  aggregateType: "PharmacySite",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.siteId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted when the set of states a pharmacy site may dispense into changes (go-live G-2). Carries the resulting set plus added/removed deltas, and flags the first declaration, which is the point at which ship-to-state enforcement begins for that site.",
});

export type OrgSiteShipStatesChangedV1Payload = z.infer<typeof payloadSchema>;
