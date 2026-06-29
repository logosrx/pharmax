// /ops/admin/report-schedules — scheduled report admin.
//
// Lists every report_schedule row (ACTIVE / PAUSED / DISABLED). Each
// row links to a per-schedule edit page (cron + parameter templates
// are dangerous to edit inline). Gate: `reports.manage_schedule`.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listReportSchedules } from "../../../../src/server/ops/list-report-schedules.js";
import { PageHeader } from "../../../../src/components/ui/page.js";
import { Badge, type Tone } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";

function formatDate(d: Date | null): string {
  return d === null ? "—" : d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function statusTone(status: string): Tone {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "PAUSED":
      return "warning";
    default:
      return "neutral";
  }
}

function runStatusTone(status: string | null): Tone {
  switch (status) {
    case "SUCCEEDED":
      return "success";
    case "FAILED":
      return "danger";
    case "SKIPPED":
      return "warning";
    default:
      return "neutral";
  }
}

export default async function ReportSchedulesAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly flash?: string; readonly error?: string }>;
}) {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_MANAGE_SCHEDULE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Report schedules" />
        <PermissionDenied grant="reports.manage_schedule" />
      </div>
    );
  }

  const rows = await listReportSchedules({ tenancy: result.tenancy });
  const { flash, error } = await searchParams;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Administration"
        title="Report schedules"
        description="Cron-driven, unattended report executions. The worker dispatches RunReport under a per-org service identity; results land on the report_run ledger."
        actions={
          <Link
            href="/ops/admin/report-schedules/new"
            className={buttonClass({ variant: "primary" })}
          >
            <Icon name="plus" size={16} />
            New schedule
          </Link>
        }
      />

      {typeof flash === "string" && flash.length > 0 ? (
        <Banner tone="success">{flash}</Banner>
      ) : null}
      {typeof error === "string" && error.length > 0 ? (
        <Banner tone="danger">{error}</Banner>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon="schedules"
          title="No schedules yet"
          description="Create the first one to run a report on a cron."
          action={
            <Link
              href="/ops/admin/report-schedules/new"
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              New schedule
            </Link>
          }
        />
      ) : (
        <Table>
          <THead>
            <TH>Name</TH>
            <TH>Report</TH>
            <TH>Cron / TZ</TH>
            <TH>Status</TH>
            <TH>Notify</TH>
            <TH>Last run</TH>
            <TH>Next run</TH>
            <TH align="right">Runs</TH>
            <TH align="right" />
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.id}>
                <TD>
                  <span className="font-medium text-fg">{row.name}</span>
                </TD>
                <TD>
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{row.reportId}</code>
                </TD>
                <TD>
                  <div className="font-mono text-xs text-fg">{row.cronExpression}</div>
                  <div className="text-xs text-subtle">{row.timezone}</div>
                </TD>
                <TD>
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                </TD>
                <TD>
                  <div className="text-xs text-muted">{row.notifyOn}</div>
                  <div className="text-xs text-subtle">
                    {row.recipients.length === 0
                      ? "no recipients"
                      : `${row.recipients.length} recipient${row.recipients.length === 1 ? "" : "s"}`}
                  </div>
                </TD>
                <TD>
                  <div className="text-xs text-muted">{formatDate(row.lastRunAt)}</div>
                  <Badge tone={runStatusTone(row.lastRunStatus)}>
                    {row.lastRunStatus ?? "never"}
                  </Badge>
                  {row.lastRunErrorCode !== null ? (
                    <div className="mt-1 text-xs text-red-300">
                      <code>{row.lastRunErrorCode}</code>
                    </div>
                  ) : null}
                </TD>
                <TD>
                  <span className="text-xs text-muted">{formatDate(row.nextRunAt)}</span>
                </TD>
                <TD align="right">{row.runCount}</TD>
                <TD align="right">
                  <Link
                    href={`/ops/admin/report-schedules/${row.id}/edit`}
                    className={buttonClass({ variant: "secondary", size: "sm" })}
                  >
                    Edit
                  </Link>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
