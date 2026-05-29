// /ops/admin/report-schedules — scheduled report admin.
//
// Lists every report_schedule row (ACTIVE / PAUSED / DISABLED) for
// the operator's organization. Each row links to an edit page; the
// list itself is read-only.
//
// "Why no inline edit": cron expressions + parameter templates are
// dangerous things to edit in a list grid (typos blow up the next
// tick). The list shows status + last-run health; deeper changes
// go through the per-schedule edit page where validation errors
// can be surfaced with full context.
//
// Permission gate: `reports.manage_schedule`.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listReportSchedules } from "../../../../src/server/ops/list-report-schedules.js";

function formatDate(d: Date | null): string {
  if (d === null) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "border-emerald-700 bg-emerald-950 text-emerald-200";
    case "PAUSED":
      return "border-amber-700 bg-amber-950 text-amber-200";
    case "DISABLED":
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-400";
  }
}

function runStatusBadgeClass(status: string | null): string {
  if (status === null) return "border-neutral-700 bg-neutral-900 text-neutral-500";
  switch (status) {
    case "SUCCEEDED":
      return "border-emerald-700 bg-emerald-950 text-emerald-200";
    case "FAILED":
      return "border-rose-700 bg-rose-950 text-rose-200";
    case "SKIPPED":
      return "border-amber-700 bg-amber-950 text-amber-200";
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-400";
  }
}

interface PageProps {
  readonly searchParams: Promise<{ readonly flash?: string; readonly error?: string }>;
}

export default async function ReportSchedulesAdminPage({ searchParams }: PageProps) {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Report schedules</h1>
        <p className="text-rose-300">Tenancy resolution failed: {result.reason}</p>
      </main>
    );
  }
  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_MANAGE_SCHEDULE)) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Report schedules</h1>
        <p className="text-rose-300">
          Your role does not include <code>reports.manage_schedule</code>.
        </p>
      </main>
    );
  }

  const rows = await listReportSchedules({ tenancy: result.tenancy });
  const { flash, error } = await searchParams;

  return (
    <main className="space-y-6 p-6 text-neutral-100">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Report schedules</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Cron-driven, unattended report executions. The worker picks up due schedules on each
            tick and dispatches <code>RunReport</code> under a per-org service identity (
            <code>reports-scheduler@&lt;org-slug&gt;.test</code>). Results land on the{" "}
            <code>report_run</code> ledger; viewing past runs is a follow-up slice.
          </p>
        </div>
        <Link
          href="/ops/admin/report-schedules/new"
          className="rounded-md border border-emerald-700 bg-emerald-950 px-3 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-900"
        >
          New schedule
        </Link>
      </header>

      {typeof flash === "string" && flash.length > 0 ? (
        <div className="rounded-md border border-emerald-800 bg-emerald-950 px-4 py-2 text-sm text-emerald-200">
          {flash}
        </div>
      ) : null}
      {typeof error === "string" && error.length > 0 ? (
        <div className="rounded-md border border-rose-800 bg-rose-950 px-4 py-2 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          No schedules yet. Click <strong>New schedule</strong> to create the first one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-neutral-800">
          <table className="w-full divide-y divide-neutral-800 text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Report</th>
                <th className="px-3 py-2 text-left">Cron / TZ</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Notify</th>
                <th className="px-3 py-2 text-left">Last run</th>
                <th className="px-3 py-2 text-left">Next run</th>
                <th className="px-3 py-2 text-right">Runs</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800 bg-neutral-950">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-neutral-900/60">
                  <td className="px-3 py-2 font-medium text-neutral-100">{row.name}</td>
                  <td className="px-3 py-2 text-neutral-300">
                    <code className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs">
                      {row.reportId}
                    </code>
                  </td>
                  <td className="px-3 py-2 text-neutral-300">
                    <div className="font-mono text-xs">{row.cronExpression}</div>
                    <div className="text-xs text-neutral-500">{row.timezone}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(row.status)}`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-neutral-300">
                    <div className="text-xs">{row.notifyOn}</div>
                    <div className="text-xs text-neutral-500">
                      {row.recipients.length === 0
                        ? "no recipients"
                        : `${row.recipients.length} recipient${row.recipients.length === 1 ? "" : "s"}`}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-neutral-300">
                    <div>{formatDate(row.lastRunAt)}</div>
                    <span
                      className={`mt-1 inline-block rounded border px-2 py-0.5 text-xs font-medium ${runStatusBadgeClass(row.lastRunStatus)}`}
                    >
                      {row.lastRunStatus ?? "never"}
                    </span>
                    {row.lastRunErrorCode !== null ? (
                      <div className="mt-1 text-xs text-rose-300">
                        <code>{row.lastRunErrorCode}</code>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-neutral-300">{formatDate(row.nextRunAt)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
                    {row.runCount}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/ops/admin/report-schedules/${row.id}/edit`}
                      className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
