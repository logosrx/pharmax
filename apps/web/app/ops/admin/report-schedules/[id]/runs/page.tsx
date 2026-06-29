// /ops/admin/report-schedules/[id]/runs — per-schedule history.
//
// Lists the 100 most-recent report_run rows for ONE schedule, with a
// per-run delivery rollup (did the email reach recipients?). Gate:
// `reports.manage_schedule`.

import Link from "next/link";
import { notFound } from "next/navigation";

import { REPORT_REGISTRY } from "@pharmax/reporting";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { getReportScheduleById } from "../../../../../../src/server/ops/list-report-schedules.js";
import { listReportRunsBySchedule } from "../../../../../../src/server/ops/list-report-runs.js";
import {
  rollupDeliveriesByReportRun,
  type DeliveryRollup,
} from "../../../../../../src/server/ops/list-notification-deliveries.js";
import { PageHeader } from "../../../../../../src/components/ui/page.js";
import { Badge } from "../../../../../../src/components/ui/badge.js";
import {
  Banner,
  EmptyState,
  PermissionDenied,
} from "../../../../../../src/components/ui/feedback.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../../../src/components/ui/data.js";
import { buttonClass } from "../../../../../../src/components/ui/button.js";
import { Icon } from "../../../../../../src/components/ui/icon.js";

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function formatDate(d: Date | null): string {
  return d === null ? "—" : d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function DeliveryCell({ rollup }: { readonly rollup: DeliveryRollup | undefined }) {
  if (rollup === undefined || rollup.total === 0) {
    return <span className="text-subtle">no emails</span>;
  }
  const problems = rollup.bounced + rollup.complained + rollup.failed + rollup.delayed;
  return (
    <span className="flex flex-wrap gap-1">
      {rollup.delivered > 0 ? <Badge tone="success">{rollup.delivered} delivered</Badge> : null}
      {rollup.inFlight > 0 ? <Badge tone="info">{rollup.inFlight} in-flight</Badge> : null}
      {problems > 0 ? (
        <Badge tone="danger">
          {problems} problem{problems === 1 ? "" : "s"}
        </Badge>
      ) : null}
    </span>
  );
}

export default async function ScheduleRunsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<{ readonly error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_MANAGE_SCHEDULE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Schedule runs" />
        <PermissionDenied grant="reports.manage_schedule" />
      </div>
    );
  }

  const schedule = await getReportScheduleById({ tenancy: result.tenancy, reportScheduleId: id });
  if (schedule === null) notFound();

  const rows = await listReportRunsBySchedule({
    tenancy: result.tenancy,
    scheduleId: id,
    limit: 100,
  });
  const reportTitle = REPORT_REGISTRY[schedule.reportId]?.title ?? schedule.reportId;
  const deliveryRollups = await rollupDeliveriesByReportRun({
    tenancy: result.tenancy,
    reportRunIds: rows.map((r) => r.id),
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href={`/ops/admin/report-schedules/${id}/edit`}
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to schedule
      </Link>

      <PageHeader
        eyebrow="Administration · Schedule runs"
        title={schedule.name}
        description={
          <span>
            {reportTitle} · <code>{schedule.cronExpression}</code> ({schedule.timezone})
          </span>
        }
      />

      {typeof error === "string" && error.length > 0 ? (
        <Banner tone="danger">{error}</Banner>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon="history"
          title="This schedule hasn't fired yet"
          description={`Next run at ${formatDate(schedule.nextRunAt)}.`}
        />
      ) : (
        <Table>
          <THead>
            <TH>Generated</TH>
            <TH>Window</TH>
            <TH align="right">Rows</TH>
            <TH align="right">Size</TH>
            <TH>Delivery</TH>
            <TH align="right">CSV</TH>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.id}>
                <TD>
                  <span className="text-xs text-muted">{formatDate(row.generatedAt)}</span>
                </TD>
                <TD>
                  <span className="text-xs text-muted">
                    {formatDate(row.windowFrom)} → {formatDate(row.windowTo)}
                  </span>
                </TD>
                <TD align="right">{row.rowCount}</TD>
                <TD align="right">
                  <span className="text-xs text-muted">{formatBytes(row.csvSizeBytes)}</span>
                </TD>
                <TD>
                  <DeliveryCell rollup={deliveryRollups.get(row.id)} />
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
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
