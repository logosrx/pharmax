// org.bucket.updated.v1 — a bucket's display attributes changed.
//
// Producer: `UpdateBucket` (`@pharmax/orgs`).
// Consumers: admin activity feed; queue UIs that cache bucket labels
//   and ordering.
//
// Fires for BOTH system and custom buckets — an admin may relabel or
// reorder a seeded bucket, which is a display change the queue UI
// needs to pick up. `isSystem` is carried so a consumer can tell the
// two apart without a lookup, and `fieldsChanged` names exactly what
// moved. `code` never appears here: it is immutable on every bucket
// (see UpdateBucket) because the workflow engine resolves buckets by
// code, so a rename would silently re-point live order routing.
//
// PHI: none. Bucket identifiers and attribute names only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const BUCKET_KINDS = ["WORKFLOW", "EMERGENCY", "HOLD", "EXCEPTION", "CUSTOM"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    bucketId: z.uuid(),
    /** Immutable identifier, echoed so consumers need no lookup. */
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    kind: z.enum(BUCKET_KINDS),
    sortOrder: z.number().int(),
    /** True when the bucket is one of the seeded canonical set. */
    isSystem: z.boolean(),
    /** Which attributes actually changed (empty on a no-op save). */
    fieldsChanged: z.array(z.enum(["name", "sortOrder", "kind"])).max(3),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgBucketUpdatedV1 = defineEvent({
  name: "org.bucket.updated",
  version: 1,
  aggregateType: "Bucket",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.bucketId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.provisioning",
  description:
    "Emitted by UpdateBucket after a bucket's display name, sort order, or (custom buckets only) kind changes. The bucket code is immutable and never appears in fieldsChanged.",
});

export type OrgBucketUpdatedV1Payload = z.infer<typeof payloadSchema>;
