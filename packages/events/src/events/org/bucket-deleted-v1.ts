// org.bucket.deleted.v1 — a custom operational bucket was removed.
//
// Producer: `DeleteBucket` (`@pharmax/orgs`).
// Consumers: the queue-counts broadcaster (stop publishing a counter
//   for a bucket that no longer exists); admin activity feed.
//
// Deletion is HARD, not a soft archive: the `bucket` model carries no
// `isActive` / `archivedAt` column, and DeleteBucket refuses whenever
// any order still references the row. So this event means the bucket
// is gone AND nothing pointed at it — consumers can drop their cached
// entry outright rather than tombstoning it.
//
// The full attribute snapshot travels in the payload because the row
// no longer exists to dereference: this event plus the audit row is
// the only remaining record of what the bucket was.
//
// PHI: none. Bucket identifiers only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const BUCKET_KINDS = ["WORKFLOW", "EMERGENCY", "HOLD", "EXCEPTION", "CUSTOM"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    bucketId: z.uuid(),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    kind: z.enum(BUCKET_KINDS),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgBucketDeletedV1 = defineEvent({
  name: "org.bucket.deleted",
  version: 1,
  aggregateType: "Bucket",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.bucketId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted by DeleteBucket after a custom bucket row is removed. Only ever fires for non-system buckets that held zero orders at delete time, so consumers may drop cached entries outright.",
});

export type OrgBucketDeletedV1Payload = z.infer<typeof payloadSchema>;
