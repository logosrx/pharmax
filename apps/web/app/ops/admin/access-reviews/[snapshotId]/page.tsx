// /ops/admin/access-reviews/[snapshotId] — snapshot detail.
//
// Single-row view of an access_review_snapshot: provenance (digest,
// command-log anchor, recorder), summary scalars, and the persisted
// JSON report. The digest is the tamper-evidence claim — the evidence
// file must hash to this value. PHI: none (operator identity only).
// Gate: `compliance.access_review.view`.

import Link from "next/link";
import { notFound } from "next/navigation";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { getAccessReviewSnapshotById } from "../../../../../src/server/ops/list-access-review-snapshots.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { DataList, Stat } from "../../../../../src/components/ui/data.js";
import { PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { Icon } from "../../../../../src/components/ui/icon.js";

function formatDate(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function AccessReviewSnapshotDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly snapshotId: string }>;
}) {
  const { snapshotId } = await params;

  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.COMPLIANCE_ACCESS_REVIEW_VIEW)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Compliance" title="Access review snapshot" />
        <PermissionDenied grant="compliance.access_review.view" />
      </div>
    );
  }

  const detail = await getAccessReviewSnapshotById({ tenancy: result.tenancy, snapshotId });
  if (detail === null) notFound();

  const reportJson = JSON.stringify(detail.report, null, 2);

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/access-reviews"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to access reviews
      </Link>

      <PageHeader
        eyebrow="Compliance"
        title="Access review snapshot"
        description={`Generated ${formatDate(detail.generatedAt)} · period ${formatDateOnly(detail.periodStart)} → ${formatDateOnly(detail.periodEnd)} · org ${detail.organizationSlug}`}
      />

      <Section title="Provenance">
        <Card>
          <CardContent>
            <DataList
              columns={2}
              items={[
                {
                  label: "Snapshot id",
                  value: <code className="break-all font-mono text-xs">{detail.id}</code>,
                },
                { label: "Report version", value: `v${detail.reportVersion}` },
                {
                  label: "Digest (SHA-256, canonical JSON)",
                  value: <code className="break-all font-mono text-xs">{detail.digestSha256}</code>,
                  span: 2,
                },
                {
                  label: "Command log id",
                  value: <code className="break-all font-mono text-xs">{detail.commandLogId}</code>,
                },
                {
                  label: "Recorded by",
                  value:
                    detail.recorder === null ? (
                      <span className="text-subtle">— (system-tier job)</span>
                    ) : (
                      <span>
                        {detail.recorder.displayName ?? "(no display name)"}
                        {detail.recorder.email !== null ? (
                          <span className="text-subtle"> &lt;{detail.recorder.email}&gt;</span>
                        ) : null}
                      </span>
                    ),
                },
                { label: "Persisted at", value: formatDate(detail.createdAt) },
              ]}
            />
          </CardContent>
        </Card>
      </Section>

      <Section title="Summary">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Total principals" value={detail.totalPrincipals} />
          <Stat
            label="Elevated"
            value={detail.elevatedPrincipalCount}
            tone={detail.elevatedPrincipalCount > 0 ? "info" : "neutral"}
          />
          <Stat
            label="Inactive"
            value={detail.inactivePrincipalCount}
            tone={detail.inactivePrincipalCount > 0 ? "warning" : "neutral"}
          />
          <Stat
            label="Stale assignments"
            value={detail.staleAssignmentCount}
            tone={detail.staleAssignmentCount > 0 ? "warning" : "neutral"}
          />
          <Stat
            label="Crypto-shred roles"
            value={detail.cryptoShredCapableRoleCount}
            tone={detail.cryptoShredCapableRoleCount > 0 ? "info" : "neutral"}
          />
        </div>
      </Section>

      <Section title="Persisted report (JSON)">
        <Card>
          <CardContent className="space-y-3">
            <p className="text-xs text-subtle">
              The full <code>AccessReviewReport</code> payload frozen at write time. Recompute the
              SHA-256 of the canonical (sorted-key) serialization to verify against the digest
              above.
            </p>
            <pre className="max-h-[60vh] overflow-auto rounded-md border border-line bg-surface-2 p-3 text-xs leading-relaxed text-muted">
              {reportJson}
            </pre>
          </CardContent>
        </Card>
      </Section>
    </div>
  );
}
