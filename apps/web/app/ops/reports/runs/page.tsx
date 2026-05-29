// /ops/reports/runs — org-wide report-run history.
//
// Lists the 100 most-recent `report_run` rows for the active org.
// Each row shows the report id, generated-at timestamp, window
// covered, row count, source ("operator" vs "schedule" via
// `runViaScheduleId`), and either a "Download CSV" button (when
// `csvObjectKey IS NOT NULL`) or an inline "Not archived" badge.
//
// Permission gate: `reports.run` — same gate the run itself
// required. We don't introduce a separate "view history"
// permission today because the use case is identical and the
// data shape (aggregates only — no PHI) is the same.

import Link from "next/link";

import { REPORT_REGISTRY } from "@pharmax/reporting";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listReportRuns } from "../../../../src/server/ops/list-report-runs.js";

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(d: Date | null): string {
  if (d === null) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

interface PageProps {
  readonly searchParams: Promise<{ readonly error?: string }>;
}

export default async function ReportRunsHistoryPage({ searchParams }: PageProps) {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Report runs</h1>
        <p className="text-rose-300">Tenancy resolution failed: {result.reason}</p>
      </main>
    );
  }
  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_RUN)) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Report runs</h1>
        <p className="text-rose-300">
          Your role does not include <code>reports.run</code>.
        </p>
      </main>
    );
  }

  const rows = await listReportRuns({ tenancy: result.tenancy, limit: 100 });
  const { error } = await searchParams;

  return (
    <main className="space-y-6 p-6 text-neutral-100">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Report runs</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Every report execution for this organization, newest first. Click{" "}
            <strong>Download CSV</strong> to re-fetch the bytes from the run archive (when
            persisted). Scheduled runs always persist their CSV; operator-initiated runs stream the
            CSV in-browser at run time and are not stored.
          </p>
        </div>
        <Link href="/ops/reports" className="text-sm text-neutral-400 hover:text-neutral-200">
          ← Reports catalog
        </Link>
      </header>

      {typeof error === "string" && error.length > 0 ? (
        <div className="rounded-md border border-rose-800 bg-rose-950 px-4 py-2 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          No report runs yet. Run one from <code>/ops/reports</code> or set up a schedule under{" "}
          <code>/ops/admin/report-schedules</code>.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-neutral-800">
          <table className="w-full divide-y divide-neutral-800 text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2 text-left">Report</th>
                <th className="px-3 py-2 text-left">Window</th>
                <th className="px-3 py-2 text-left">Generated</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-right">Rows</th>
                <th className="px-3 py-2 text-right">Size</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800 bg-neutral-950">
              {rows.map((row) => {
                const title = REPORT_REGISTRY[row.reportId]?.title ?? row.reportId;
                return (
                  <tr key={row.id} className="hover:bg-neutral-900/60">
                    <td className="px-3 py-2">
                      <div className="font-medium text-neutral-100">{title}</div>
                      <code className="text-xs text-neutral-500">{row.reportId}</code>
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-300">
                      {formatDate(row.windowFrom)} → {formatDate(row.windowTo)}
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-300">
                      {formatDate(row.generatedAt)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {row.runViaScheduleId !== null ? (
                        <span className="rounded border border-violet-800 bg-violet-950 px-2 py-0.5 text-violet-200">
                          schedule
                        </span>
                      ) : (
                        <span className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-neutral-400">
                          operator
                        </span>
                      )}{" "}
                      <span className="text-neutral-500">{row.runByDisplayName ?? ""}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
                      {row.rowCount}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs text-neutral-300">
                      {formatBytes(row.csvSizeBytes)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.hasCsv ? (
                        <a
                          href={`/api/ops/reports/runs/${row.id}/download`}
                          className="rounded border border-emerald-700 bg-emerald-950 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-900"
                        >
                          Download CSV
                        </a>
                      ) : (
                        <span className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-500">
                          Not archived
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
