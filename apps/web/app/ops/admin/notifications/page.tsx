// /ops/admin/notifications — notification delivery health.
//
// Lists the 100 most-recent notification_delivery rows for the
// org (recipient, template, status, last event, failure reason).
// A `?problems=1` filter narrows to BOUNCED / COMPLAINED /
// DELIVERY_DELAYED / FAILED — the rows an operator should chase
// (a bouncing recipient on a schedule means the report isn't
// reaching someone).
//
// Permission gate: `notifications.read` — a dedicated read
// permission so delivery-health visibility is decoupled from
// schedule management (and from reports entirely, ahead of
// notifications expanding beyond scheduled reports).

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listNotificationDeliveries } from "../../../../src/server/ops/list-notification-deliveries.js";

function formatDate(d: Date | null): string {
  if (d === null) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "DELIVERED":
      return "border-emerald-700 bg-emerald-950 text-emerald-200";
    case "SENT":
      return "border-sky-700 bg-sky-950 text-sky-200";
    case "QUEUED":
      return "border-neutral-700 bg-neutral-900 text-neutral-300";
    case "DELIVERY_DELAYED":
      return "border-amber-700 bg-amber-950 text-amber-200";
    case "BOUNCED":
    case "COMPLAINED":
    case "FAILED":
    case "CANCELLED":
    default:
      return "border-rose-700 bg-rose-950 text-rose-200";
  }
}

interface PageProps {
  readonly searchParams: Promise<{ readonly problems?: string }>;
}

export default async function NotificationsHealthPage({ searchParams }: PageProps) {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Notification delivery</h1>
        <p className="text-rose-300">Tenancy resolution failed: {result.reason}</p>
      </main>
    );
  }
  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.NOTIFICATIONS_READ)) {
    return (
      <main className="space-y-2 p-6 text-neutral-100">
        <h1 className="text-2xl font-semibold">Notification delivery</h1>
        <p className="text-rose-300">
          Your role does not include <code>notifications.read</code>.
        </p>
      </main>
    );
  }

  const { problems } = await searchParams;
  const problemsOnly = problems === "1";
  const rows = await listNotificationDeliveries({
    tenancy: result.tenancy,
    limit: 100,
    problemsOnly,
  });

  return (
    <main className="space-y-6 p-6 text-neutral-100">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Notification delivery</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Per-recipient delivery health for outbound notifications. Rows are written when a send
            is attempted (QUEUED → SENT) and advanced by the Resend delivery webhook (DELIVERED /
            BOUNCED / COMPLAINED / DELIVERY_DELAYED). A bouncing recipient on a schedule means the
            report isn&apos;t reaching someone.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link
            href="/ops/admin/notifications"
            className={`rounded-md border px-3 py-2 text-sm ${
              problemsOnly
                ? "border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
                : "border-sky-700 bg-sky-950 text-sky-200"
            }`}
          >
            All
          </Link>
          <Link
            href="/ops/admin/notifications?problems=1"
            className={`rounded-md border px-3 py-2 text-sm ${
              problemsOnly
                ? "border-rose-700 bg-rose-950 text-rose-200"
                : "border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
            }`}
          >
            Problems only
          </Link>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          {problemsOnly
            ? "No problem deliveries — every recent notification was accepted or delivered."
            : "No notification deliveries recorded yet."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-neutral-800">
          <table className="w-full divide-y divide-neutral-800 text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2 text-left">Recipient</th>
                <th className="px-3 py-2 text-left">Template</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Last event</th>
                <th className="px-3 py-2 text-left">Sent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800 bg-neutral-950">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-neutral-900/60">
                  <td className="px-3 py-2 font-medium text-neutral-100">{row.recipientAddress}</td>
                  <td className="px-3 py-2 text-neutral-300">
                    <code className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs">
                      {row.template}
                    </code>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(row.status)}`}
                    >
                      {row.status}
                    </span>
                    {row.failureReason !== null ? (
                      <div className="mt-1 text-xs text-rose-300">{row.failureReason}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-300">
                    <div>{row.lastEventType ?? "—"}</div>
                    <div className="text-neutral-500">{formatDate(row.lastEventAt)}</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-300">
                    {formatDate(row.createdAt)}
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
