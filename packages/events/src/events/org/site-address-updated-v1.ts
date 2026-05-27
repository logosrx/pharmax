// org.site.address_updated.v1 — pharmacy site address changed.
//
// Producer: `UpdatePharmacySiteAddress` (`@pharmax/orgs`).
// Consumers: shipping label `from_address` cache invalidation;
//   compliance log (state board notifications).
//
// PHI: the site is an operator-owned address (not a patient
// address) — not PHI by HIPAA's definition. The payload still
// carries only ids and a list of changed-field names, never the
// new address values themselves, so downstream rendering must
// re-read the site row.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const ADDRESS_FIELD_NAMES = [
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "country",
  "phone",
] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    siteId: z.uuid(),
    /**
     * Names of the address fields that changed in this update.
     * Always non-empty (no-op updates short-circuit before emit).
     */
    fieldsChanged: z.array(z.enum(ADDRESS_FIELD_NAMES)).min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgSiteAddressUpdatedV1 = defineEvent({
  name: "org.site.address_updated",
  version: 1,
  aggregateType: "PharmacySite",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.siteId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted by UpdatePharmacySiteAddress after a site address mutation. Carries the changed-field names so consumers can decide whether to invalidate cached label `from` addresses.",
});

export type OrgSiteAddressUpdatedV1Payload = z.infer<typeof payloadSchema>;
