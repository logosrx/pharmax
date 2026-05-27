// org.buckets.provisioned.v1 — default operational buckets seeded for a site.
//
// Producer: `ProvisionDefaultBuckets` (`@pharmax/orgs`), also
//   emitted by `CreateOrganization` alongside `organization.created.v1`
//   when the bootstrap path creates the first site.
// Consumers: dashboards that surface per-site bucket counts; future
//   "your queue is empty" onboarding nudge.
//
// PHI: none. Site id + counts only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    siteId: z.uuid(),
    /** Count of buckets newly inserted by this command. */
    created: z.number().int().min(0),
    /** Count of buckets that already existed and were left alone. */
    alreadyPresent: z.number().int().min(0),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgBucketsProvisionedV1 = defineEvent({
  name: "org.buckets.provisioned",
  version: 1,
  aggregateType: "PharmacySite",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.siteId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted by ProvisionDefaultBuckets (and the CreateOrganization bootstrap path) after the seven canonical workflow buckets are inserted for a pharmacy site.",
});

export type OrgBucketsProvisionedV1Payload = z.infer<typeof payloadSchema>;
