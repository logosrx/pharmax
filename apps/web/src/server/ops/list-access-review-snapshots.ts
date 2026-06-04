// Read helpers for the `access_review_snapshot` projection.
//
// Powers the SOC 2 access-review history surface
// (`/ops/admin/access-reviews` list + `[snapshotId]` detail). All
// reads are tenant-scoped via `readInTenantContext`, which gives the
// canonical both-layers isolation guarantee:
//   1. The Prisma tenancy extension narrows the WHERE clause to the
//      current org (ORM layer).
//   2. The Postgres `pharmax.organization_id` session GUC engages the
//      `tenant_isolation` RLS policy on the row (DB layer).
//
// The `report` JSONB column is intentionally NOT loaded by the list
// helper — list rendering needs only the summary scalars +
// provenance metadata, and the full report is multi-KB. The detail
// helper loads the full payload because the detail view renders it
// (or makes it available for download).
//
// PHI: `access_review_snapshot.report` carries operator identity
// (email, displayName) but NEVER patient data — enforced by
// `generateAccessReview` upstream and codified on
// `RecordAccessReviewSnapshot`. This module treats `report` as
// opaque JSON; the detail page renders selected fields after the
// helper returns.

import "server-only";

import { readInTenantContext } from "@pharmax/database";
import type { Prisma } from "@pharmax/database";
import { type TenancyContext } from "@pharmax/tenancy";

// ---------------------------------------------------------------------------
// List rows — scalar projection only (no JSONB)
// ---------------------------------------------------------------------------

export interface AccessReviewSnapshotListRow {
  readonly id: string;
  readonly organizationSlug: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly generatedAt: Date;
  readonly totalPrincipals: number;
  readonly elevatedPrincipalCount: number;
  readonly inactivePrincipalCount: number;
  readonly staleAssignmentCount: number;
  readonly cryptoShredCapableRoleCount: number;
  readonly digestSha256: string;
  readonly reportVersion: number;
  readonly recordedByUserId: string | null;
  readonly commandLogId: string;
  readonly createdAt: Date;
}

const LIST_SELECT = {
  id: true,
  organizationSlug: true,
  periodStart: true,
  periodEnd: true,
  generatedAt: true,
  totalPrincipals: true,
  elevatedPrincipalCount: true,
  inactivePrincipalCount: true,
  staleAssignmentCount: true,
  cryptoShredCapableRoleCount: true,
  digestSha256: true,
  reportVersion: true,
  recordedByUserId: true,
  commandLogId: true,
  createdAt: true,
} as const;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * List the most-recent access-review snapshots for the operator's
 * org, newest first. Snapshots are immutable evidence rows; the
 * "history" semantic is just chronological order.
 *
 * `limit` is clamped to `[1, MAX_LIST_LIMIT]` defensively — a
 * misconfigured caller can't request a billion-row dump.
 */
export async function listAccessReviewSnapshots(input: {
  readonly tenancy: TenancyContext;
  readonly limit?: number;
}): Promise<ReadonlyArray<AccessReviewSnapshotListRow>> {
  const limit = clampLimit(input.limit ?? DEFAULT_LIST_LIMIT);
  return readInTenantContext(input.tenancy, async (tx) => {
    const rows = await tx.accessReviewSnapshot.findMany({
      orderBy: { generatedAt: "desc" },
      take: limit,
      select: LIST_SELECT,
    });
    return rows.map(freezeListRow);
  });
}

// ---------------------------------------------------------------------------
// Detail row — includes report JSONB + recorder display
// ---------------------------------------------------------------------------

/**
 * Operator-facing identity for the user who recorded the snapshot.
 * `null` covers both the "no recordedByUserId" case (future
 * scheduled-worker writes) and the rare "recorder user has since
 * been deleted" case (FK is ON DELETE RESTRICT today, but we keep
 * the projection defensive for forward-compat).
 */
export interface AccessReviewSnapshotRecorder {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

export interface AccessReviewSnapshotDetail extends AccessReviewSnapshotListRow {
  readonly report: Prisma.JsonValue;
  readonly recorder: AccessReviewSnapshotRecorder | null;
}

const DETAIL_SELECT = {
  ...LIST_SELECT,
  report: true,
  recordedByUser: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
} as const;

/**
 * Load a single snapshot by id, scoped to the operator's tenancy.
 * Returns `null` when the row does not exist OR exists in another
 * org (RLS makes those indistinguishable from the caller's
 * perspective, which is the right behaviour — no cross-org leakage
 * via 404 vs 403 timing).
 */
export async function getAccessReviewSnapshotById(input: {
  readonly tenancy: TenancyContext;
  readonly snapshotId: string;
}): Promise<AccessReviewSnapshotDetail | null> {
  return readInTenantContext(input.tenancy, async (tx) => {
    const row = await tx.accessReviewSnapshot.findUnique({
      where: { id: input.snapshotId },
      select: DETAIL_SELECT,
    });
    if (row === null) return null;
    return Object.freeze({
      ...freezeListRow(row),
      report: row.report,
      recorder:
        row.recordedByUser === null
          ? null
          : Object.freeze({
              id: row.recordedByUser.id,
              email: row.recordedByUser.email,
              displayName: row.recordedByUser.displayName,
            }),
    });
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Defensively clamp the caller-supplied limit to a sane window. */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  const truncated = Math.trunc(limit);
  if (truncated < 1) return 1;
  if (truncated > MAX_LIST_LIMIT) return MAX_LIST_LIMIT;
  return truncated;
}

/**
 * Lightweight health classification for a snapshot, used by the list
 * page to surface "this snapshot found something a reviewer should
 * look at" without re-parsing the JSONB. Three buckets:
 *   - "clean"     — no elevated principals, no stale assignments,
 *                   no inactive principals.
 *   - "attention" — at least one stale assignment OR inactive
 *                   principal. The reviewer's main signal.
 *   - "elevated-only" — elevated principals exist but no stale /
 *                       inactive flags. Informational (every org
 *                       has at least one OrgAdmin).
 */
export type AccessReviewSnapshotHealth = "clean" | "elevated-only" | "attention";

export function classifySnapshotHealth(
  row: Pick<
    AccessReviewSnapshotListRow,
    "elevatedPrincipalCount" | "inactivePrincipalCount" | "staleAssignmentCount"
  >
): AccessReviewSnapshotHealth {
  if (row.staleAssignmentCount > 0 || row.inactivePrincipalCount > 0) {
    return "attention";
  }
  if (row.elevatedPrincipalCount > 0) {
    return "elevated-only";
  }
  return "clean";
}

function freezeListRow(row: {
  readonly id: string;
  readonly organizationSlug: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly generatedAt: Date;
  readonly totalPrincipals: number;
  readonly elevatedPrincipalCount: number;
  readonly inactivePrincipalCount: number;
  readonly staleAssignmentCount: number;
  readonly cryptoShredCapableRoleCount: number;
  readonly digestSha256: string;
  readonly reportVersion: number;
  readonly recordedByUserId: string | null;
  readonly commandLogId: string;
  readonly createdAt: Date;
}): AccessReviewSnapshotListRow {
  return Object.freeze({
    id: row.id,
    organizationSlug: row.organizationSlug,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    generatedAt: row.generatedAt,
    totalPrincipals: row.totalPrincipals,
    elevatedPrincipalCount: row.elevatedPrincipalCount,
    inactivePrincipalCount: row.inactivePrincipalCount,
    staleAssignmentCount: row.staleAssignmentCount,
    cryptoShredCapableRoleCount: row.cryptoShredCapableRoleCount,
    digestSha256: row.digestSha256,
    reportVersion: row.reportVersion,
    recordedByUserId: row.recordedByUserId,
    commandLogId: row.commandLogId,
    createdAt: row.createdAt,
  });
}
