// org.clinic_provider_affiliation.created.v1 — a prescriber was granted
// authority to write for a client practice.
//
// Producer: `AffiliateProviderWithClinic` (`@pharmax/orgs`).
// Consumers: access-review evidence (this is the grant that answers
//   "who could prescribe for this client on date D"); admin activity
//   feed; the portal, whose client chooser is driven by these rows.
//
// `reactivated` distinguishes a first-time affiliation from an ENDED
// row flipped back to ACTIVE. Both are the same grant with the same
// consequence, but an access reviewer reads them differently: a
// reactivation means someone previously decided to remove this access
// and someone has now reversed that.
//
// PHI: none. Prescriber identity is public NPI-registry data and no
// patient row is referenced.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    affiliationId: z.uuid(),
    clinicId: z.uuid(),
    providerId: z.uuid(),
    /** Public CMS identifier; the stable anchor for this grant. */
    npi: z.string().regex(/^\d{10}$/),
    /** True when an ENDED affiliation was restored rather than created. */
    reactivated: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgClinicProviderAffiliatedV1 = defineEvent({
  name: "org.clinic_provider_affiliation.created",
  version: 1,
  aggregateType: "ClinicProviderAffiliation",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.affiliationId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted by AffiliateProviderWithClinic when a prescriber gains authority to write for a client. `reactivated` is true when a previously-ended affiliation was restored, which an access reviewer reads differently from a first grant.",
});

export type OrgClinicProviderAffiliatedV1Payload = z.infer<typeof payloadSchema>;
