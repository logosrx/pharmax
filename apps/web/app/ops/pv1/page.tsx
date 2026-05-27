// /ops/pv1 — pharmacist PV1 queue.
//
// Lists orders currently in the PV1 bucket. Two row variants:
//
//   - TYPED_READY_FOR_PV1: anyone with `pv1.start` can "Claim"
//     the order to begin PV1 (calls StartPV1, transitions to
//     PV1_IN_PROGRESS, stamps the operator as `currentAssigneeUserId`).
//
//   - PV1_IN_PROGRESS: the assignee (and only the assignee, per
//     the command's `pv1.approve` / `pv1.reject` permissions +
//     `ship_not_assigned_to_actor` guard family) can Approve or
//     Reject. We surface both actions only when the operator
//     owns the row; otherwise the row renders read-only with
//     "Claimed by <other>".
//
// Permission gates per action:
//   - "Claim": pv1.start
//   - "Approve": pv1.approve
//   - "Reject": pv1.reject
//
// PHI: order rows are non-PHI by design; the queue surfaces
// external order number + status + priority + age only. The full
// order detail (patient, prescription, lines) is a future page —
// PV1 pharmacists need it BEFORE they approve. Today they have
// to read the data out of the database directly. That gap is
// documented in the plan; this slice keeps the workflow loop
// closeable end-to-end via the existing CLI / dev flows for the
// underlying data, and validates the queue + action shape.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";
import { PV1_REJECTION_REASONS } from "@pharmax/verification";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import { listOrdersInBucketByCode } from "../../../src/server/ops/list-orders-in-bucket.js";

const PV1_FLASH: Readonly<Record<string, string>> = {
  claimed: "Claimed for PV1.",
  approved: "Approved PV1; order moved to the FILL bucket.",
  rejected: "Rejected PV1; order routed back to TYPING.",
};

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function priorityBadgeClass(priority: string): string {
  switch (priority) {
    case "EMERGENCY":
      return "border-red-700 bg-red-950 text-red-200";
    case "RUSH":
      return "border-amber-700 bg-amber-950 text-amber-200";
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-400";
  }
}

export default async function Pv1QueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  // Page is visible to anyone who can at least START PV1 (the
  // pharmacist surface). Read-only viewers can be added in a
  // future slice with a separate `pv1.read` permission.
  if (!hasOperatorPermission(permissions, PERMISSIONS.PV1_START)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">PV1 queue</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to access the PV1 queue. Contact your admin to request the{" "}
          <code className="text-neutral-200">pv1.start</code> grant (Pharmacist role).
        </p>
      </main>
    );
  }

  const canApprove = hasOperatorPermission(permissions, PERMISSIONS.PV1_APPROVE);
  const canReject = hasOperatorPermission(permissions, PERMISSIONS.PV1_REJECT);

  const queue = await listOrdersInBucketByCode({
    organizationId: session.tenancy.organizationId,
    bucketCode: "PV1",
  });

  const flashKey = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashOrderId = typeof params["orderId"] === "string" ? params["orderId"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;
  const now = Date.now();

  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">PV1 queue</h1>
        <p className="text-sm text-neutral-400">
          Pharmacist verification (PV1). Claim a ready order to begin, or approve / reject the one
          you&apos;re working.
        </p>
      </header>

      {flashKey !== null && PV1_FLASH[flashKey] !== undefined ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          {PV1_FLASH[flashKey]}{" "}
          {flashOrderId !== null ? (
            <code className="font-mono text-emerald-100">{flashOrderId}</code>
          ) : null}
        </div>
      ) : null}
      {flashError !== null ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          {flashError}
        </div>
      ) : null}

      {!queue.bucketExists ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          The PV1 bucket is not provisioned for this organization. Run{" "}
          <code className="text-neutral-200">ProvisionDefaultBuckets</code> to create it.
        </div>
      ) : queue.rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          No orders waiting for PV1.
        </div>
      ) : (
        <ul className="space-y-3">
          {queue.rows.map((row) => {
            const isReady = row.currentStatus === "TYPED_READY_FOR_PV1";
            const isInProgress = row.currentStatus === "PV1_IN_PROGRESS";
            const isMine = isInProgress && row.currentAssigneeUserId === session.operator.userId;
            const otherAssignee =
              isInProgress &&
              row.currentAssigneeUserId !== null &&
              row.currentAssigneeUserId !== session.operator.userId;
            const ageMs = now - row.receivedAt.getTime();
            const overSla = row.slaDeadlineAt !== null && row.slaDeadlineAt.getTime() < now;

            return (
              <li
                key={row.orderId}
                className={`space-y-3 rounded-md border bg-neutral-950 p-4 ${
                  overSla ? "border-red-800" : "border-neutral-800"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm">
                      <Link
                        href={`/ops/orders/${row.orderId}`}
                        className="font-mono text-neutral-100 hover:text-blue-300 hover:underline"
                      >
                        {row.externalOrderNumber ?? row.orderId}
                      </Link>
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${priorityBadgeClass(
                          row.priority
                        )}`}
                      >
                        {row.priority}
                      </span>
                      <span className="text-xs text-neutral-500">{row.currentStatus}</span>
                    </div>
                    <div className="text-xs text-neutral-500">
                      Received {formatDuration(ageMs)} ago
                      {row.slaDeadlineAt !== null ? (
                        <>
                          {" · "}SLA{" "}
                          <span className={overSla ? "text-red-400" : "text-neutral-300"}>
                            {overSla
                              ? "BREACHED"
                              : `due in ${formatDuration(row.slaDeadlineAt.getTime() - now)}`}
                          </span>
                        </>
                      ) : null}
                    </div>
                    {otherAssignee ? (
                      <div className="text-xs text-neutral-500">
                        Claimed by{" "}
                        <code className="text-neutral-300">{row.currentAssigneeUserId}</code>
                      </div>
                    ) : null}
                  </div>
                </div>

                {isReady ? (
                  <form
                    action={`/api/ops/orders/${row.orderId}/start-pv1`}
                    method="POST"
                    className="flex flex-wrap items-center gap-2"
                  >
                    <button
                      type="submit"
                      className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
                    >
                      Claim (Start PV1)
                    </button>
                  </form>
                ) : null}

                {isMine ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {canApprove ? (
                      <form action={`/api/ops/orders/${row.orderId}/approve-pv1`} method="POST">
                        <button
                          type="submit"
                          className="rounded-md border border-emerald-700 bg-emerald-900 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-800"
                        >
                          Approve PV1
                        </button>
                      </form>
                    ) : null}
                    {canReject ? (
                      <form
                        action={`/api/ops/orders/${row.orderId}/reject-pv1`}
                        method="POST"
                        className="flex flex-wrap items-center gap-2"
                      >
                        <label className="sr-only" htmlFor={`reject-${row.orderId}`}>
                          Rejection reason
                        </label>
                        <select
                          id={`reject-${row.orderId}`}
                          name="reasonCode"
                          defaultValue="DOSE_INCORRECT"
                          className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
                        >
                          {PV1_REJECTION_REASONS.map((reason) => (
                            <option key={reason} value={reason}>
                              {reason}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="rounded-md border border-red-700 bg-red-900 px-3 py-1.5 text-sm text-red-100 hover:bg-red-800"
                        >
                          Reject PV1
                        </button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
