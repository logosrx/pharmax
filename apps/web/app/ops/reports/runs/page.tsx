// /ops/reports/runs — org-wide report-run history.
//
// Lists the 100 most-recent `report_run` rows. Each shows the report,
// window, generated-at, source (operator vs schedule), row count, size,
// and either a download (when archived) or a "not archived" badge.
// Gate: `reports.run` (same data shape, no PHI).

import Link from "next/link";

import { REPORT_REGISTRY } from "@pharmax/reporting";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listReportRuns } from "../../../../src/server/ops/list-report-runs.js";
import { PageHeader } from "../../../../src/components/ui/page.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(d: Date | null): string {
  return d === null ? "—" : d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export default async function ReportRunsHistoryPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly error?: string }>;
}) {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_RUN)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Finance" title="Report history" />
        <PermissionDenied grant="reports.run" />
      </div>
    );
  }

  const rows = await listReportRuns({ tenancy: result.tenancy, limit: 100 });
  const { error } = await searchParams;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Finance"
        title="Report history"
        description="Every report execution for this organization, newest first. Scheduled runs persist their CSV; operator-initiated runs stream at run time and aren't stored."
        actions={
          <Link href="/ops/reports" className={buttonClass({ variant: "secondary", size: "sm" })}>
            <Icon name="reports" size={15} />
            Catalog
          </Link>
        }
      />

      {typeof error === "string" && error.length > 0 ? (
        <Banner tone="danger">{error}</Banner>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon="history"
          title="No report runs yet"
          description="Run one from the reports catalog or set up a schedule under Administration."
        />
      ) : (
        <Table>
          <THead>
            <TH>Report</TH>
            <TH>Window</TH>
            <TH>Generated</TH>
            <TH>Source</TH>
            <TH align="right">Rows</TH>
            <TH align="right">Size</TH>
            <TH align="right">CSV</TH>
          </THead>
          <TBody>
            {rows.map((row) => {
              const title = REPORT_REGISTRY[row.reportId]?.title ?? row.reportId;
              return (
                <TR key={row.id}>
                  <TD>
                    <div className="font-medium text-fg">{title}</div>
                    <code className="text-xs text-subtle">{row.reportId}</code>
                  </TD>
                  <TD>
                    <span className="text-xs text-muted">
                      {formatDate(row.windowFrom)} → {formatDate(row.windowTo)}
                    </span>
                  </TD>
                  <TD>
                    <span className="text-xs text-muted">{formatDate(row.generatedAt)}</span>
                  </TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Badge tone={row.runViaScheduleId !== null ? "violet" : "neutral"}>
                        {row.runViaScheduleId !== null ? "schedule" : "operator"}
                      </Badge>
                      {row.runByDisplayName ? (
                        <span className="text-xs text-subtle">{row.runByDisplayName}</span>
                      ) : null}
                    </div>
                  </TD>
                  <TD align="right">{row.rowCount}</TD>
                  <TD align="right">
                    <span className="text-xs text-muted">{formatBytes(row.csvSizeBytes)}</span>
                  </TD>
                  <TD align="right">
                    {row.hasCsv ? (
                      <a
                        href={`/api/ops/reports/runs/${row.id}/download`}
                        className={buttonClass({ variant: "go", size: "sm" })}
                      >
                        <Icon name="arrowRight" size={13} />
                        Download
                      </a>
                    ) : (
                      <Badge tone="neutral">Not archived</Badge>
                    )}
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
