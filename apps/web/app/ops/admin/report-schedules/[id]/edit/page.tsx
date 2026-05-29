// /ops/admin/report-schedules/[id]/edit — edit a schedule.
//
// Two forms on the page:
//   1. Edit form — name + cron + timezone + parametersTemplate +
//      status. Posts to UpdateReportSchedule.
//   2. Disable form — separate button so the operator can't
//      accidentally disable while editing other fields.
//
// The reportId is NOT editable (refuse to change the underlying
// report — operator creates a new schedule + disables the old).

import Link from "next/link";
import { notFound } from "next/navigation";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { getReportScheduleById } from "../../../../../../src/server/ops/list-report-schedules.js";

interface PageProps {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<{
    readonly flash?: string;
    readonly error?: string;
  }>;
}

export default async function EditReportSchedulePage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { flash, error } = await searchParams;

  const result = await resolveOperatorTenancyContext();
  if (!result.ok) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Edit schedule</h1>
        <p className="text-rose-300">Tenancy resolution failed: {result.reason}</p>
      </main>
    );
  }
  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_MANAGE_SCHEDULE)) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Edit schedule</h1>
        <p className="text-rose-300">
          Your role does not include <code>reports.manage_schedule</code>.
        </p>
      </main>
    );
  }

  const row = await getReportScheduleById({
    tenancy: result.tenancy,
    reportScheduleId: id,
  });
  if (row === null) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 text-neutral-100">
      <header>
        <Link
          href="/ops/admin/report-schedules"
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          ← Back to schedules
        </Link>
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold">{row.name}</h1>
          <Link
            href={`/ops/admin/report-schedules/${row.id}/runs`}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800"
          >
            View run history →
          </Link>
        </div>
        <p className="mt-1 text-sm text-neutral-400">
          Report:{" "}
          <code className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs">{row.reportId}</code> ·
          Status:{" "}
          <span className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs">
            {row.status}
          </span>
        </p>
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

      <form
        action={`/api/ops/admin/report-schedules/${row.id}/update`}
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
            defaultValue={row.name}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
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
            defaultValue={row.cronExpression}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-100"
          />
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
            defaultValue={row.timezone}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
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
            defaultValue={JSON.stringify(row.parametersTemplate, null, 2)}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100"
          />
        </div>

        <div className="grid gap-2">
          <label htmlFor="status" className="text-sm font-medium text-neutral-200">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={row.status}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          >
            <option value="ACTIVE">ACTIVE — included in worker tick</option>
            <option value="PAUSED">PAUSED — visible but not dispatched</option>
            <option value="DISABLED">DISABLED — soft-deleted</option>
          </select>
        </div>

        <div className="grid gap-2">
          <label htmlFor="recipients" className="text-sm font-medium text-neutral-200">
            Email recipients
          </label>
          <textarea
            id="recipients"
            name="recipients"
            rows={3}
            defaultValue={row.recipients.join(", ")}
            placeholder="billing@acme.test, ops-lead@acme.test"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100"
          />
          <p className="text-xs text-neutral-500">
            Comma-, space-, or newline-separated operator email addresses (max 50). Leave blank for
            &ldquo;scheduled but silent&rdquo; mode.
          </p>
        </div>

        <div className="grid gap-2">
          <label htmlFor="notifyOn" className="text-sm font-medium text-neutral-200">
            Notify on
          </label>
          <select
            id="notifyOn"
            name="notifyOn"
            defaultValue={row.notifyOn}
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
            Save changes
          </button>
        </div>
      </form>

      <form
        action={`/api/ops/admin/report-schedules/${row.id}/disable`}
        method="POST"
        className="rounded-md border border-rose-900 bg-rose-950/50 p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-rose-200">Disable schedule</h2>
            <p className="mt-1 text-xs text-rose-300">
              Soft-deletes the schedule. The audit trail is preserved; an admin can resurrect by
              editing the row and choosing <code>ACTIVE</code>.
            </p>
          </div>
          <button
            type="submit"
            className="rounded-md border border-rose-700 bg-rose-950 px-4 py-2 text-sm font-medium text-rose-200 hover:bg-rose-900"
          >
            Disable
          </button>
        </div>
      </form>
    </main>
  );
}
