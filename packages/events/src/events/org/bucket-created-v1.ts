// org.bucket.created.v1 — a custom operational bucket was created.
//
// Producer: `CreateBucket` (`@pharmax/orgs`).
// Consumers: the queue-counts broadcaster (a new bucket means a new
//   counter to publish); admin activity feed; saved-view tooling that
//   caches the org's bucket vocabulary.
//
// Only CUSTOM buckets reach this event — the seven canonical ones are
// seeded by ProvisionDefaultBuckets and announced by
// `org.buckets.provisioned.v1`. `isSystem` is therefore always false
// here and is not carried in the payload.
//
// PHI: none. Bucket identifiers and scope ids only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const BUCKET_KINDS = ["WORKFLOW", "EMERGENCY", "HOLD", "EXCEPTION", "CUSTOM"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    bucketId: z.uuid(),
    /** Org-unique bucket identifier (e.g. `COMPOUNDING_QUEUE`). */
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    kind: z.enum(BUCKET_KINDS),
    sortOrder: z.number().int(),
    /** Optional narrowing scope; null means org-wide. */
    siteId: z.uuid().nullable(),
    clinicId: z.uuid().nullable(),
    teamId: z.uuid().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgBucketCreatedV1 = defineEvent({
  name: "org.bucket.created",
  version: 1,
  aggregateType: "Bucket",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.bucketId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted by CreateBucket after a custom (non-system) operational queue bucket is persisted. Never fires for the seven canonical workflow buckets, which are announced by org.buckets.provisioned.v1.",
});

export type OrgBucketCreatedV1Payload = z.infer<typeof payloadSchema>;
