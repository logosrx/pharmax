// EMERGENCY-queue operator page.
//
// Lists orders currently in the EMERGENCY bucket for the operator's
// tenancy. Each row carries a "Resolve" form that POSTs to the
// /api/ops/orders/:id/resolve-escalation route — which dispatches
// the standard `ResolveOrderEscalation` command through the bus.
//
// Why server-rendered form (vs. client-side fetch):
//   - Zero client JS for the simplest path. Operators on slow
//     terminals get a working page even before any JS hydrates.
//   - Failures surface as a clean re-render with the typed error
//     code in the URL — no client-side error-handling boilerplate.
//   - When the operator console grows a SPA-shell, individual
//     forms can upgrade to client components incrementally without
//     re-plumbing the auth + dispatch path.

import Link from "next/link";
import { redirect } from "next/navigation";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import { listEmergencyOrders } from "../../../src/server/ops/list-emergency-orders.js";

const DISPOSITION_OPTIONS = [
  { value: "RETURN_TO_SHIPPING", label: "Return to Shipping" },
  { value: "RETURN_TO_FILL", label: "Return to Fill" },
  { value: "KEEP_IN_EMERGENCY", label: "Keep in Emergency (audit only)" },
] as const;

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export default async function EmergencyQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) redirect("/sign-in");

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.SHIP_RESOLVE_ESCALATION)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Emergency queue</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to disposition emergency orders. Contact your admin to
          request the <code className="text-neutral-200">ship.resolve_escalation</code> grant.
        </p>
      </main>
    );
  }

  const queue = await listEmergencyOrders({
    organizationId: result.tenancy.organizationId,
  });

  const flash = typeof params["resolved"] === "string" ? params["resolved"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;
  const now = Date.now();

  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Emergency queue</h1>
        <p className="text-sm text-neutral-400">
          Orders currently escalated to the EMERGENCY bucket. Disposition each to return it to a
          workflow bucket or acknowledge ongoing triage.
        </p>
      </header>

      {flash !== null ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          Resolved order <code className="font-mono">{flash}</code>.
        </div>
      ) : null}
      {flashError !== null ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          {flashError}
        </div>
      ) : null}

      {!queue.bucketExists ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          The EMERGENCY bucket is not provisioned for this organization. Run{" "}
          <code className="text-neutral-200">ProvisionDefaultBuckets</code> to create it.
        </div>
      ) : queue.rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          No orders in the EMERGENCY bucket. Nothing to disposition.
        </div>
      ) : (
        <ul className="space-y-3">
          {queue.rows.map((row) => {
            const minutesEscalated = Math.floor((now - row.enteredEmergencyAt.getTime()) / 60_000);
            return (
              <li
                key={row.orderId}
                className="space-y-3 rounded-md border border-neutral-800 bg-neutral-950 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <Link
                      href={`/ops/orders/${row.orderId}`}
                      className="font-mono text-sm text-neutral-100 hover:text-blue-300 hover:underline"
                    >
                      {row.externalOrderNumber ?? row.orderId}
                    </Link>
                    <div className="text-xs text-neutral-500">
                      Status <span className="text-neutral-300">{row.currentStatus}</span> ·
                      Priority <span className="text-neutral-300">{row.priority}</span> · Escalated{" "}
                      <span className="text-neutral-300">
                        {formatDuration(now - row.enteredEmergencyAt.getTime())}
                      </span>{" "}
                      ago
                    </div>
                    {row.latestShipmentEvent !== null ? (
                      <div className="text-xs text-neutral-500">
                        Latest shipment event:{" "}
                        <span className="text-neutral-300">{row.latestShipmentEvent.kind}</span> (
                        {row.latestShipmentEvent.carrierStatus})
                      </div>
                    ) : null}
                  </div>
                  <div className="text-right text-xs text-neutral-600">{minutesEscalated} min</div>
                </div>

                <form
                  action={`/api/ops/orders/${row.orderId}/resolve-escalation`}
                  method="POST"
                  className="flex flex-wrap items-center gap-2"
                >
                  <label className="sr-only" htmlFor={`disposition-${row.orderId}`}>
                    Disposition
                  </label>
                  <select
                    id={`disposition-${row.orderId}`}
                    name="disposition"
                    defaultValue="RETURN_TO_SHIPPING"
                    className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
                  >
                    {DISPOSITION_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    name="reasonText"
                    placeholder="Optional operator note"
                    maxLength={2000}
                    className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
                  />
                  <button
                    type="submit"
                    className="rounded-md border border-emerald-700 bg-emerald-900 px-4 py-2 text-sm text-emerald-100 hover:bg-emerald-800"
                  >
                    Resolve
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
