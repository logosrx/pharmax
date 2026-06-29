// /ops/admin/access-reviews — SOC 2 access-review snapshot history.
//
// Read-only operator surface over immutable, digest-sealed snapshots
// of every (user → role → scope → permission) assignment, produced by
// the quarterly access-review job. This page does NOT trigger new
// snapshots. Gate: `compliance.access_review.view`.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  classifySnapshotHealth,
  listAccessReviewSnapshots,
  type AccessReviewSnapshotHealth,
  type AccessReviewSnapshotListRow,
} from "../../../../src/server/ops/list-access-review-snapshots.js";
import { PageHeader } from "../../../../src/components/ui/page.js";
import { Badge, type Tone } from "../../../../src/components/ui/badge.js";
import { EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { buttonClass } from "../../../../src/components/ui/button.js";

function formatDate(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function formatPeriod(start: Date, end: Date): string {
  return `${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`;
}
function truncateDigest(digest: string): string {
  return digest.length <= 16 ? digest : `${digest.slice(0, 8)}…${digest.slice(-8)}`;
}

const HEALTH_META: Record<AccessReviewSnapshotHealth, { tone: Tone; label: string }> = {
  clean: { tone: "success", label: "CLEAN" },
  "elevated-only": { tone: "info", label: "ELEVATED ONLY" },
  attention: { tone: "warning", label: "ATTENTION" },
};

export default async function AccessReviewSnapshotsPage() {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.COMPLIANCE_ACCESS_REVIEW_VIEW)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Compliance" title="Access reviews" />
        <PermissionDenied grant="compliance.access_review.view" />
      </div>
    );
  }

  const rows: ReadonlyArray<AccessReviewSnapshotListRow> = await listAccessReviewSnapshots({
    tenancy: result.tenancy,
    limit: 50,
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Compliance"
        title="Access reviews"
        description="Immutable, digest-sealed snapshots of every (user → role → permission) assignment. SOC 2 CC6.2 evidence; write-once and tamper-evident via canonical-JSON SHA-256. ATTENTION rows have a stale assignment or inactive principal to re-justify."
      />

      {rows.length === 0 ? (
        <EmptyState
          icon="shield"
          title="No access-review snapshots yet"
          description="The quarterly review is run via scripts/security/run-access-review.ts or fires automatically once the scheduled worker is configured."
        />
      ) : (
        <Table>
          <THead>
            <TH>Generated</TH>
            <TH>Period</TH>
            <TH align="right">Principals</TH>
            <TH align="right">Elevated</TH>
            <TH align="right">Stale</TH>
            <TH align="right">Inactive</TH>
            <TH>Health</TH>
            <TH>Digest</TH>
            <TH align="right" />
          </THead>
          <TBody>
            {rows.map((row) => {
              const meta = HEALTH_META[classifySnapshotHealth(row)];
              return (
                <TR key={row.id}>
                  <TD>
                    <span className="text-xs text-muted">{formatDate(row.generatedAt)}</span>
                  </TD>
                  <TD>
                    <span className="text-xs text-muted">
                      {formatPeriod(row.periodStart, row.periodEnd)}
                    </span>
                  </TD>
                  <TD align="right">{row.totalPrincipals}</TD>
                  <TD align="right">{row.elevatedPrincipalCount}</TD>
                  <TD align="right">
                    <span className={row.staleAssignmentCount > 0 ? "text-amber-300" : undefined}>
                      {row.staleAssignmentCount}
                    </span>
                  </TD>
                  <TD align="right">
                    <span className={row.inactivePrincipalCount > 0 ? "text-amber-300" : undefined}>
                      {row.inactivePrincipalCount}
                    </span>
                  </TD>
                  <TD>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </TD>
                  <TD>
                    <span className="font-mono text-xs text-subtle" title={row.digestSha256}>
                      {truncateDigest(row.digestSha256)}
                    </span>
                  </TD>
                  <TD align="right">
                    <Link
                      href={`/ops/admin/access-reviews/${row.id}`}
                      className={buttonClass({ variant: "secondary", size: "sm" })}
                    >
                      Open
                    </Link>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
