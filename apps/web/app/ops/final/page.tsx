// /ops/final — pharmacist FINAL VERIFICATION queue.
//
// The second pharmacist signature surface. Lists orders in the
// FINAL bucket. Two row variants:
//
//   - FILL_COMPLETED_READY_FOR_FINAL: anyone with `final.start`
//     can "Claim" the order to begin verification (calls
//     StartFinalVerification, transitions to
//     FINAL_VERIFICATION_IN_PROGRESS, stamps the operator as
//     `currentAssigneeUserId`).
//
//   - FINAL_VERIFICATION_IN_PROGRESS: only the assignee surfaces
//     Approve / Reject actions. ApproveFinalVerification carries a
//     Separation-of-Duties guard at the bus that REJECTS an
//     approval by the SAME pharmacist who did PV1 (the same-person
//     pre-check below is a UX hint — the loud guard is the bus
//     check on dispatch).
//
// Permission gates per action:
//   - "Claim": final.start
//   - "Approve": final.approve
//   - "Reject": final.reject
//
// PHI: queue surface only carries non-PHI structural columns. The
// order-detail page (`/ops/orders/[id]`) is where the verifying
// pharmacist reads the patient + drug + sig before signing — same
// pattern as PV1.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";
import { FINAL_REJECTION_REASONS } from "@pharmax/verification";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { SlaBadge, slaRowBorderClass, slaStatusFor } from "../../../src/components/sla-badge.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import { listOrdersInBucketByCode } from "../../../src/server/ops/list-orders-in-bucket.js";

const FINAL_FLASH: Readonly<Record<string, string>> = {
  claimed: "Claimed for final verification.",
  approved: "Approved; order moved to the SHIPPING bucket.",
  rejected: "Rejected; order routed back to FILL for rework.",
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

export default async function FinalQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.FINAL_START)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Final verification queue</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to access the final verification queue. Contact your admin
          to request the <code className="text-neutral-200">final.start</code> grant (Pharmacist
          role).
        </p>
      </main>
    );
  }

  const canApprove = hasOperatorPermission(permissions, PERMISSIONS.FINAL_APPROVE);
  const canReject = hasOperatorPermission(permissions, PERMISSIONS.FINAL_REJECT);

  const queue = await listOrdersInBucketByCode({
    organizationId: session.tenancy.organizationId,
    bucketCode: "FINAL",
  });

  const flashKey = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashOrderId = typeof params["orderId"] === "string" ? params["orderId"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;
  const now = Date.now();

  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Final verification queue</h1>
        <p className="text-sm text-neutral-400">
          Second pharmacist signature. Claim a fill-completed order to verify, then approve to
          release for shipping or reject back to FILL.
        </p>
      </header>

      {flashKey !== null && FINAL_FLASH[flashKey] !== undefined ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          {FINAL_FLASH[flashKey]}{" "}
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
          The FINAL bucket is not provisioned for this organization. Run{" "}
          <code className="text-neutral-200">ProvisionDefaultBuckets</code> to create it.
        </div>
      ) : queue.rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          No orders waiting for final verification.
        </div>
      ) : (
        <ul className="space-y-3">
          {queue.rows.map((row) => {
            const isReady = row.currentStatus === "FILL_COMPLETED_READY_FOR_FINAL";
            const isInProgress = row.currentStatus === "FINAL_VERIFICATION_IN_PROGRESS";
            const isMine = isInProgress && row.currentAssigneeUserId === session.operator.userId;
            const otherAssignee =
              isInProgress &&
              row.currentAssigneeUserId !== null &&
              row.currentAssigneeUserId !== session.operator.userId;
            const ageMs = now - row.receivedAt.getTime();
            const nowDate = new Date(now);
            const slaStatus = slaStatusFor(row.slaDeadlineAt, nowDate);

            return (
              <li
                key={row.orderId}
                className={`space-y-3 rounded-md border bg-neutral-950 p-4 ${slaRowBorderClass(
                  slaStatus
                )}`}
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
                      <SlaBadge slaDeadlineAt={row.slaDeadlineAt} now={nowDate} />
                    </div>
                    <div className="text-xs text-neutral-500">
                      Received {formatDuration(ageMs)} ago
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
                    action={`/api/ops/orders/${row.orderId}/start-final`}
                    method="POST"
                    className="flex flex-wrap items-center gap-2"
                  >
                    <button
                      type="submit"
                      className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
                    >
                      Claim (Start final verification)
                    </button>
                  </form>
                ) : null}

                {isMine ? (
                  <div className="space-y-2">
                    <div className="text-xs text-amber-400">
                      Separation of duties: if you also performed PV1 on this order, approval will
                      be rejected at the command bus. Use Reject and route to another pharmacist if
                      needed.
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {canApprove ? (
                        <form action={`/api/ops/orders/${row.orderId}/approve-final`} method="POST">
                          <button
                            type="submit"
                            className="rounded-md border border-emerald-700 bg-emerald-900 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-800"
                          >
                            Approve final
                          </button>
                        </form>
                      ) : null}
                      {canReject ? (
                        <form
                          action={`/api/ops/orders/${row.orderId}/reject-final`}
                          method="POST"
                          className="flex flex-wrap items-center gap-2"
                        >
                          <label className="sr-only" htmlFor={`reject-${row.orderId}`}>
                            Rejection reason
                          </label>
                          <select
                            id={`reject-${row.orderId}`}
                            name="reasonCode"
                            defaultValue={FINAL_REJECTION_REASONS[0]}
                            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
                          >
                            {FINAL_REJECTION_REASONS.map((reason) => (
                              <option key={reason} value={reason}>
                                {reason}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="rounded-md border border-red-700 bg-red-900 px-3 py-1.5 text-sm text-red-100 hover:bg-red-800"
                          >
                            Reject final
                          </button>
                        </form>
                      ) : null}
                    </div>
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
