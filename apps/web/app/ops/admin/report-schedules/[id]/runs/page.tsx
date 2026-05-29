// /ops/admin/report-schedules/[id]/runs — per-schedule history.
//
// Lists the 100 most-recent `report_run` rows for ONE schedule.
// Same row shape as the org-wide history page; filtered to
// `runViaScheduleId = :id` so an admin debugging "did my Monday
// report actually fire last week" gets a focused view.
//
// Permission gate: `reports.manage_schedule` (the operator who
// can edit the schedule can also see its runs).

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

function DeliveryCell({ rollup }: { readonly rollup: DeliveryRollup | undefined }) {
  if (rollup === undefined || rollup.total === 0) {
    return <span className="text-neutral-600">no emails</span>;
  }
  const problems = rollup.bounced + rollup.complained + rollup.failed + rollup.delayed;
  return (
    <span className="flex flex-wrap gap-1">
      {rollup.delivered > 0 ? (
        <span className="rounded border border-emerald-800 bg-emerald-950 px-1.5 py-0.5 text-emerald-200">
          {rollup.delivered} delivered
        </span>
      ) : null}
      {rollup.inFlight > 0 ? (
        <span className="rounded border border-sky-800 bg-sky-950 px-1.5 py-0.5 text-sky-200">
          {rollup.inFlight} in-flight
        </span>
      ) : null}
      {problems > 0 ? (
        <span className="rounded border border-rose-800 bg-rose-950 px-1.5 py-0.5 text-rose-200">
          {problems} problem{problems === 1 ? "" : "s"}
        </span>
      ) : null}
    </span>
  );
}

interface PageProps {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<{ readonly error?: string }>;
}

export default async function ScheduleRunsPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { error } = await searchParams;

  const result = await resolveOperatorTenancyContext();
  if (!result.ok) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Schedule runs</h1>
        <p className="text-rose-300">Tenancy resolution failed: {result.reason}</p>
      </main>
    );
  }
  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_MANAGE_SCHEDULE)) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Schedule runs</h1>
        <p className="text-rose-300">
          Your role does not include <code>reports.manage_schedule</code>.
        </p>
      </main>
    );
  }

  const schedule = await getReportScheduleById({
    tenancy: result.tenancy,
    reportScheduleId: id,
  });
  if (schedule === null) {
    notFound();
  }

  const rows = await listReportRunsBySchedule({
    tenancy: result.tenancy,
    scheduleId: id,
    limit: 100,
  });
  const reportTitle = REPORT_REGISTRY[schedule.reportId]?.title ?? schedule.reportId;
  // Delivery rollup per run (correlationId on notification_delivery
  // is the reportRunId) so the admin sees "did the email actually
  // reach recipients" alongside "did the report run".
  const deliveryRollups = await rollupDeliveriesByReportRun({
    tenancy: result.tenancy,
    reportRunIds: rows.map((r) => r.id),
  });

  return (
    <main className="space-y-6 p-6 text-neutral-100">
      <header>
        <Link
          href={`/ops/admin/report-schedules/${id}/edit`}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          ← Back to schedule
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{schedule.name}</h1>
        <p className="mt-1 text-sm text-neutral-400">
          {reportTitle} ·{" "}
          <code className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs">
            {schedule.cronExpression}
          </code>{" "}
          ({schedule.timezone})
        </p>
      </header>

      {typeof error === "string" && error.length > 0 ? (
        <div className="rounded-md border border-rose-800 bg-rose-950 px-4 py-2 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          This schedule has not fired yet. The next run is at{" "}
          <code>{formatDate(schedule.nextRunAt)}</code>.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-neutral-800">
          <table className="w-full divide-y divide-neutral-800 text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2 text-left">Generated</th>
                <th className="px-3 py-2 text-left">Window</th>
                <th className="px-3 py-2 text-right">Rows</th>
                <th className="px-3 py-2 text-right">Size</th>
                <th className="px-3 py-2 text-left">Delivery</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800 bg-neutral-950">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-neutral-900/60">
                  <td className="px-3 py-2 text-xs text-neutral-300">
                    {formatDate(row.generatedAt)}
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-300">
                    {formatDate(row.windowFrom)} → {formatDate(row.windowTo)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-300">
                    {row.rowCount}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs text-neutral-300">
                    {formatBytes(row.csvSizeBytes)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <DeliveryCell rollup={deliveryRollups.get(row.id)} />
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
