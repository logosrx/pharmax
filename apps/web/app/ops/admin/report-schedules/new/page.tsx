// /ops/admin/report-schedules/new — create a new schedule.
//
// The form has 4 inputs:
//   - name           — display label, unique per (org, reportId)
//   - reportId       — dropdown populated from REPORT_REGISTRY
//   - cronExpression — 5-field cron string
//   - timezone       — IANA timezone (default "UTC")
//   - parametersTemplate — JSON textarea (defaults to a
//     "from=now-30d, to=now" template — operator can edit)
//
// Form posts to `/api/ops/admin/report-schedules/create` which
// dispatches CreateReportSchedule and redirects back here.

import { REPORT_REGISTRY } from "@pharmax/reporting";
import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";

const DEFAULT_TEMPLATE = `{
  "from": "now-30d",
  "to": "now"
}`;

const SUGGESTED_CRONS: ReadonlyArray<{ label: string; expr: string }> = [
  { label: "Every 15 minutes", expr: "*/15 * * * *" },
  { label: "Hourly (top of hour)", expr: "0 * * * *" },
  { label: "Daily at 06:00 local", expr: "0 6 * * *" },
  { label: "Weekly Monday 09:00 local", expr: "0 9 * * 1" },
  { label: "Monthly on the 1st 09:00 local", expr: "0 9 1 * *" },
];

interface PageProps {
  readonly searchParams: Promise<{ readonly error?: string }>;
}

export default async function NewReportSchedulePage({ searchParams }: PageProps) {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">New schedule</h1>
        <p className="text-rose-300">Tenancy resolution failed: {result.reason}</p>
      </main>
    );
  }
  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_MANAGE_SCHEDULE)) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">New schedule</h1>
        <p className="text-rose-300">
          Your role does not include <code>reports.manage_schedule</code>.
        </p>
      </main>
    );
  }

  const reports = Object.values(REPORT_REGISTRY);
  const { error } = await searchParams;

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 text-neutral-100">
      <header>
        <Link
          href="/ops/admin/report-schedules"
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          ← Back to schedules
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">New schedule</h1>
      </header>

      {typeof error === "string" && error.length > 0 ? (
        <div className="rounded-md border border-rose-800 bg-rose-950 px-4 py-2 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      <form
        action="/api/ops/admin/report-schedules/create"
        method="POST"
        className="space-y-5 rounded-md border border-neutral-800 bg-neutral-950 p-6"
      >
        <div className="grid gap-2">
          <label htmlFor="name" className="text-sm font-medium text-neutral-200">
            Schedule name
          </label>
          <input
            id="name"
            name="name"
            required
            maxLength={120}
            placeholder="Weekly volume Mondays"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
          <p className="text-xs text-neutral-500">
            Must be unique for the selected report within this organization.
          </p>
        </div>

        <div className="grid gap-2">
          <label htmlFor="reportId" className="text-sm font-medium text-neutral-200">
            Report
          </label>
          <select
            id="reportId"
            name="reportId"
            required
            defaultValue=""
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          >
            <option value="" disabled>
              — choose a report —
            </option>
            {reports.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title} ({r.id})
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2">
          <label htmlFor="cronExpression" className="text-sm font-medium text-neutral-200">
            Cron expression
          </label>
          <input
            id="cronExpression"
            name="cronExpression"
            required
            maxLength={120}
            placeholder="0 9 * * 1"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-100"
          />
          <details className="text-xs text-neutral-500">
            <summary className="cursor-pointer hover:text-neutral-300">Common patterns</summary>
            <ul className="mt-2 space-y-1">
              {SUGGESTED_CRONS.map((c) => (
                <li key={c.expr}>
                  <code className="rounded bg-neutral-900 px-1.5 py-0.5 text-neutral-300">
                    {c.expr}
                  </code>{" "}
                  — {c.label}
                </li>
              ))}
            </ul>
          </details>
        </div>

        <div className="grid gap-2">
          <label htmlFor="timezone" className="text-sm font-medium text-neutral-200">
            Timezone
          </label>
          <input
            id="timezone"
            name="timezone"
            required
            maxLength={64}
            defaultValue="UTC"
            placeholder="America/New_York"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
          <p className="text-xs text-neutral-500">
            IANA timezone — the cron expression fires in this zone.
          </p>
        </div>

        <div className="grid gap-2">
          <label htmlFor="parametersTemplate" className="text-sm font-medium text-neutral-200">
            Parameters template (JSON)
          </label>
          <textarea
            id="parametersTemplate"
            name="parametersTemplate"
            required
            rows={8}
            defaultValue={DEFAULT_TEMPLATE}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100"
          />
          <p className="text-xs text-neutral-500">
            Supports relative-date placeholders: <code>now</code>, <code>now-1h</code>,{" "}
            <code>now-6h</code>, <code>now-12h</code>, <code>now-24h</code>, <code>now-7d</code>,{" "}
            <code>now-14d</code>, <code>now-30d</code>, <code>now-90d</code>. Resolved at each tick.
          </p>
        </div>

        <div className="grid gap-2">
          <label htmlFor="recipients" className="text-sm font-medium text-neutral-200">
            Email recipients
          </label>
          <textarea
            id="recipients"
            name="recipients"
            rows={3}
            placeholder="billing@acme.test, ops-lead@acme.test"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100"
          />
          <p className="text-xs text-neutral-500">
            Comma-, space-, or newline-separated operator email addresses (max 50). Leave blank for
            &ldquo;scheduled but silent&rdquo; mode &mdash; the run still writes to the report
            ledger and audit log; nobody is emailed.
          </p>
        </div>

        <div className="grid gap-2">
          <label htmlFor="notifyOn" className="text-sm font-medium text-neutral-200">
            Notify on
          </label>
          <select
            id="notifyOn"
            name="notifyOn"
            defaultValue="ALWAYS"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          >
            <option value="ALWAYS">ALWAYS &mdash; every dispatch</option>
            <option value="FAILURE_ONLY">FAILURE_ONLY &mdash; only failed / skipped runs</option>
            <option value="NEVER">NEVER &mdash; mute notifications (still runs)</option>
          </select>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-neutral-800 pt-4">
          <Link
            href="/ops/admin/report-schedules"
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-900"
          >
            Create schedule
          </button>
        </div>
      </form>
    </main>
  );
}
