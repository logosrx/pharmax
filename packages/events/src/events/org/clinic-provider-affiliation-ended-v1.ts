// org.clinic_provider_affiliation.ended.v1 — a prescriber's authority to
// write for a client practice was withdrawn.
//
// Producer: `EndProviderClinicAffiliation` (`@pharmax/orgs`).
// Consumers: access-review evidence; admin activity feed; security
//   feeds, because ending an affiliation revokes any portal session
//   still acting for that client on that prescriber's behalf.
//
// The reason is carried in the payload rather than left to the audit
// row. Access revocation is the one direction of this grant where "why"
// is asked months later — a prescriber who left a practice and one who
// was removed for cause are the same row otherwise.
//
// PHI: none. `reason` is operator-authored free text about a business
// relationship; the command caps its length and it must not describe a
// patient. That is a reviewer-enforced constraint, not one the schema
// can express.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    affiliationId: z.uuid(),
    clinicId: z.uuid(),
    providerId: z.uuid(),
    npi: z.string().regex(/^\d{10}$/),
    reason: z.string().min(1).max(500),
    /** Portal sessions revoked as a side effect of withdrawing access. */
    revokedPortalSessionCount: z.number().int().nonnegative(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgClinicProviderAffiliationEndedV1 = defineEvent({
  name: "org.clinic_provider_affiliation.ended",
  version: 1,
  aggregateType: "ClinicProviderAffiliation",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.affiliationId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted by EndProviderClinicAffiliation when a prescriber loses authority to write for a client. Carries the reason and the count of portal sessions revoked, since withdrawing access must not leave a live scope behind.",
});

export type OrgClinicProviderAffiliationEndedV1Payload = z.infer<typeof payloadSchema>;
