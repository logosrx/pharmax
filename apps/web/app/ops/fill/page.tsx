// /ops/fill — pharmacy tech FILL queue.
//
// Lists orders in the FILL bucket. Two row variants:
//
//   - PV1_APPROVED_READY_FOR_FILL: anyone with `fill.start` can
//     "Claim" the order (calls StartFill, transitions to
//     FILL_IN_PROGRESS, stamps the operator as the assignee).
//
//   - FILL_IN_PROGRESS: rows surface a "Open workbench" link to
//     `/ops/fill/[id]` where the assign-lot + print + scan +
//     complete actions live. Only the assignee can mutate (the
//     command-bus assignee guard enforces this); others see the
//     workbench read-only.
//
// PHI: queue surface is non-PHI. The workbench page is the action
// surface; the order-detail page is the PHI-decrypting read.

import Link from "next/link";

import { ReopenReason } from "@pharmax/database";
import { REOPEN_REASONS } from "@pharmax/orders";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { SlaBadge, slaRowBorderClass, slaStatusFor } from "../../../src/components/sla-badge.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import { listOrdersInBucketByCode } from "../../../src/server/ops/list-orders-in-bucket.js";

const FILL_FLASH: Readonly<Record<string, string>> = {
  claimed: "Claimed for fill. Workbench is open below.",
  lot_assigned: "Lot assigned.",
  label_printed: "Vial label sent to printer.",
  fill_completed: "Fill complete. Order moved to FINAL VERIFICATION.",
  reopened: "Order reopened for fill rework.",
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

export default async function FillQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.FILL_START)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Fill queue</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to access the fill queue. Contact your admin to request the{" "}
          <code className="text-neutral-200">fill.start</code> grant (Pharmacy Technician role).
        </p>
      </main>
    );
  }

  const canReopen = hasOperatorPermission(permissions, PERMISSIONS.ORDERS_REOPEN_FOR_CORRECTION);

  const queue = await listOrdersInBucketByCode({
    organizationId: session.tenancy.organizationId,
    bucketCode: "FILL",
  });

  const flashKey = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashOrderId = typeof params["orderId"] === "string" ? params["orderId"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;
  const now = Date.now();

  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Fill queue</h1>
        <p className="text-sm text-neutral-400">
          Pharmacy tech fill bench. Claim a PV1-approved order to begin; open the workbench to
          assign lots, print vial labels, and scan-complete the fill.
        </p>
      </header>

      {flashKey !== null && FILL_FLASH[flashKey] !== undefined ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          {FILL_FLASH[flashKey]}{" "}
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
          The FILL bucket is not provisioned for this organization. Run{" "}
          <code className="text-neutral-200">ProvisionDefaultBuckets</code> to create it.
        </div>
      ) : queue.rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
          No orders waiting for fill.
        </div>
      ) : (
        <ul className="space-y-3">
          {queue.rows.map((row) => {
            const isReady = row.currentStatus === "PV1_APPROVED_READY_FOR_FILL";
            const isInProgress = row.currentStatus === "FILL_IN_PROGRESS";
            const isBounced = row.currentStatus === "FINAL_VERIFICATION_REJECTED";
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
                    {isBounced ? (
                      <div className="text-xs text-amber-300">
                        Bounced back from FINAL VERIFICATION. Open the order detail to read the
                        rejection reason, then reopen for fill rework.
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {isInProgress ? (
                      <Link
                        href={`/ops/fill/${row.orderId}`}
                        className={`rounded-md border px-3 py-1.5 text-sm ${
                          isMine
                            ? "border-blue-700 bg-blue-900 text-blue-100 hover:bg-blue-800"
                            : "border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
                        }`}
                      >
                        {isMine ? "Open workbench" : "View workbench"}
                      </Link>
                    ) : null}
                  </div>
                </div>

                {isReady ? (
                  <form
                    action={`/api/ops/orders/${row.orderId}/start-fill`}
                    method="POST"
                    className="flex flex-wrap items-center gap-2"
                  >
                    <button
                      type="submit"
                      className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
                    >
                      Claim (Start fill)
                    </button>
                  </form>
                ) : null}

                {isBounced && canReopen ? (
                  <form
                    action={`/api/ops/orders/${row.orderId}/reopen-for-correction`}
                    method="POST"
                    className="grid grid-cols-1 gap-2 sm:grid-cols-4"
                  >
                    <input type="hidden" name="reopenToState" value="FILL_IN_PROGRESS" />
                    <label className="space-y-1 text-xs text-neutral-500">
                      Reason
                      <select
                        name="reason"
                        defaultValue={ReopenReason.FILL_REDO}
                        className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
                      >
                        {REOPEN_REASONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-xs text-neutral-500 sm:col-span-2">
                      Reason note (required when reason is OTHER; PHI-redacted from logs)
                      <input
                        type="text"
                        name="reasonText"
                        maxLength={2000}
                        className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
                        placeholder="optional context — required if reason=OTHER"
                      />
                    </label>
                    <div className="self-end">
                      <button
                        type="submit"
                        className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
                      >
                        Reopen → claim for fill
                      </button>
                    </div>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
