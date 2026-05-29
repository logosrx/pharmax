// compliance.access_review_snapshot.recorded.v1 — SOC 2 access-review
// evidence snapshot was persisted to the database.
//
// Producer: `RecordAccessReviewSnapshot` (`@pharmax/security`).
//   Invoked by `scripts/security/run-access-review.ts` (CLI) and the
//   future quarterly-access-review worker drain. Both call paths
//   compute the AccessReviewReport via
//   `@pharmax/security::generateAccessReview`, hash it, and dispatch
//   the command — which writes the immutable `access_review_snapshot`
//   row + emits this event.
//
// Consumers (current):
//   - Nightly security digest composer (`composeNightlySecurityDigest`)
//     surfaces the latest snapshot per org so the on-call team can
//     confirm the quarterly schedule is being met.
//
// Consumers (future):
//   - SOC 2 evidence-pack runner exports each snapshot to the per-
//     quarter evidence bundle.
//   - Compliance dashboard tile ("last access review: 3 days ago").
//   - Cross-quarter diff tool that surfaces newly-elevated or newly-
//     stale assignments since the prior snapshot.
//
// PHI invariant: the snapshot itself contains operator identity
// (email, displayName) but NEVER patient data — see the PHI
// invariant on `@pharmax/security::generateAccessReview`. This event
// payload deliberately excludes the full report; it carries only the
// snapshot id, organization id, period, summary counts, and the
// digest. Consumers that need the full report query the DB row by id
// (which goes through tenant-scoped RLS).
//
// Tamper-evidence: `digestSha256` is the canonical SHA-256 of the
// stored `report` column. A verifier can fetch the snapshot row,
// recompute the digest, and confirm it matches both the row column
// AND the value emitted on this event. Any divergence is an integrity
// incident.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    snapshotId: z.uuid(),
    organizationId: z.uuid(),
    /** Stable org slug captured at generation; renames after the
     *  fact do NOT alter historical evidence. */
    organizationSlug: z.string().min(1).max(200),
    /** Period the snapshot summarizes. ISO-8601 with timezone offset. */
    periodStart: z.iso.datetime({ offset: true }),
    periodEnd: z.iso.datetime({ offset: true }),
    /** Wall-clock time the snapshot was produced and signed. */
    generatedAt: z.iso.datetime({ offset: true }),
    /** Schema version of the persisted `report` JSONB. Increment on
     *  incompatible shape changes so verifiers can branch. */
    reportVersion: z.int().min(1).max(255),
    /** Summary scalars (also denormalized on the snapshot row). */
    totalPrincipals: z.int().min(0),
    elevatedPrincipalCount: z.int().min(0),
    inactivePrincipalCount: z.int().min(0),
    staleAssignmentCount: z.int().min(0),
    cryptoShredCapableRoleCount: z.int().min(0),
    /** Hex SHA-256 of the canonical (sorted-key) JSON serialization
     *  of the stored `report` column. 64 lowercase hex chars. */
    digestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** When `null`, the snapshot was produced by a system-tier job
     *  (future scheduled worker). When set, the operator who ran
     *  the CLI. */
    recordedByUserId: z.uuid().nullable(),
    /** Audit chain hop: snapshot → this commandLog. */
    commandLogId: z.uuid(),
    /** Event-emission wall-clock (distinct from generatedAt only when
     *  outbox is delayed past the producing transaction). */
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ComplianceAccessReviewSnapshotRecordedV1 = defineEvent({
  name: "compliance.access_review_snapshot.recorded",
  version: 1,
  aggregateType: "AccessReviewSnapshot",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.snapshotId,
  owner: "security",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.compliance",
  description:
    "Emitted by RecordAccessReviewSnapshot after an immutable AccessReviewSnapshot row is persisted. Drives the nightly security digest, the SOC 2 evidence-pack runner, and the future compliance dashboard.",
});

export type ComplianceAccessReviewSnapshotRecordedV1Payload = z.infer<typeof payloadSchema>;
