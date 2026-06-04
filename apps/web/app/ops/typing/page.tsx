// /ops/typing — typist intake / typing queue.
//
// Unlike PV1 / FILL / FINAL — which keep "ready" and "in progress"
// in the same bucket — the typing flow spans TWO buckets:
//
//   - INBOX: RECEIVED orders (just arrived; awaiting a typist to
//     claim). The typist's claim moves the order to TYPING.
//   - TYPING: TYPING_IN_PROGRESS (assignee is working it),
//     TYPING_PENDING_MISSING_INFO (assignee hit a missing-info
//     wall — exception path), and PV1_REJECTED (PV1 pharmacist
//     bounced the order back for rework per
//     `BUCKET_CODE_FOR_EXCEPTION_STATE`).
//
// This page renders both as two stacked sections so the typist
// has one screen for "claim new work" + "finish what I'm
// working" + "handle bounce-backs".
//
// Permission gates per action:
//   - "Claim (Start typing)": typing.start
//   - "Complete typing review": typing.complete
//
// PHI: queue surface is non-PHI. The order-detail page is where
// the typist reads the patient + Rx data before completing.

import Link from "next/link";

import { ReopenReason } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";
import { MISSING_INFO_REASONS } from "@pharmax/verification";
import { REOPEN_REASONS } from "@pharmax/orders";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import {
  listOrdersInBucketsByCode,
  type BucketOrderRow,
} from "../../../src/server/ops/list-orders-in-bucket.js";
import { SlaBadge, slaRowBorderClass, slaStatusFor } from "../../../src/components/sla-badge.js";

const TYPING_FLASH: Readonly<Record<string, string>> = {
  claimed: "Claimed for typing.",
  completed: "Typing review complete; order moved to PV1.",
  marked_missing: "Order marked as pending missing info. Resume when the info is back.",
  resumed: "Resumed typing.",
  reopened: "Order reopened for correction.",
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

function statusBadgeClass(status: string): string {
  switch (status) {
    case "PV1_REJECTED":
    case "TYPING_PENDING_MISSING_INFO":
      return "border-amber-700 bg-amber-950 text-amber-200";
    case "TYPING_IN_PROGRESS":
      return "border-blue-700 bg-blue-950 text-blue-200";
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-400";
  }
}

interface RowRenderProps {
  readonly row: BucketOrderRow;
  readonly nowMs: number;
  readonly operatorUserId: string;
  readonly canComplete: boolean;
  readonly canStart: boolean;
  readonly canMarkMissingInfo: boolean;
  readonly canReopen: boolean;
}

function QueueRow({
  row,
  nowMs,
  operatorUserId,
  canComplete,
  canStart,
  canMarkMissingInfo,
  canReopen,
}: RowRenderProps) {
  const ageMs = nowMs - row.receivedAt.getTime();
  const nowDate = new Date(nowMs);
  const slaStatus = slaStatusFor(row.slaDeadlineAt, nowDate);
  const isReady = row.currentStatus === "RECEIVED";
  const isInProgress = row.currentStatus === "TYPING_IN_PROGRESS";
  const isPending = row.currentStatus === "TYPING_PENDING_MISSING_INFO";
  const isBounced = row.currentStatus === "PV1_REJECTED";
  const isMine = isInProgress && row.currentAssigneeUserId === operatorUserId;
  const otherAssignee =
    isInProgress &&
    row.currentAssigneeUserId !== null &&
    row.currentAssigneeUserId !== operatorUserId;

  return (
    <li
      className={`space-y-3 rounded-md border bg-neutral-950 p-4 ${slaRowBorderClass(slaStatus)}`}
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
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${statusBadgeClass(
                row.currentStatus
              )}`}
            >
              {row.currentStatus}
            </span>
          </div>
          <div className="text-xs text-neutral-500">
            Received {formatDuration(ageMs)} ago{" "}
            <SlaBadge slaDeadlineAt={row.slaDeadlineAt} now={nowDate} />
          </div>
          {otherAssignee ? (
            <div className="text-xs text-neutral-500">
              Claimed by <code className="text-neutral-300">{row.currentAssigneeUserId}</code>
            </div>
          ) : null}
          {isBounced ? (
            <div className="text-xs text-amber-300">
              Bounced back from PV1. Open the order detail to read the rejection reason on the
              latest verification record, then reopen with corrections before re-routing to PV1.
            </div>
          ) : null}
          {isPending ? (
            <div className="text-xs text-amber-300">
              Marked as pending missing info. Resolve the gap (patient, prescriber, or sig) and
              resume typing.
            </div>
          ) : null}
        </div>
      </div>

      {isReady && canStart ? (
        <form
          action={`/api/ops/orders/${row.orderId}/start-typing`}
          method="POST"
          className="flex flex-wrap items-center gap-2"
        >
          <button
            type="submit"
            className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
          >
            Claim (Start typing)
          </button>
        </form>
      ) : null}

      {isMine && canComplete ? (
        <div className="flex flex-wrap items-center gap-2">
          <form action={`/api/ops/orders/${row.orderId}/complete-typing-review`} method="POST">
            <button
              type="submit"
              className="rounded-md border border-emerald-700 bg-emerald-900 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-800"
            >
              Complete typing review → PV1
            </button>
          </form>
          {canMarkMissingInfo ? (
            <form
              action={`/api/ops/orders/${row.orderId}/mark-typing-missing-info`}
              method="POST"
              className="flex flex-wrap items-center gap-2"
            >
              <label className="sr-only" htmlFor={`mmi-${row.orderId}`}>
                Missing info reason
              </label>
              <select
                id={`mmi-${row.orderId}`}
                name="reasonCode"
                defaultValue={MISSING_INFO_REASONS[0]}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              >
                {MISSING_INFO_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-md border border-amber-700 bg-amber-900 px-3 py-1.5 text-sm text-amber-100 hover:bg-amber-800"
              >
                Pause: missing info
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {isPending && canStart ? (
        <form
          action={`/api/ops/orders/${row.orderId}/resume-typing`}
          method="POST"
          className="flex flex-wrap items-center gap-2"
        >
          <button
            type="submit"
            className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
          >
            Resume typing
          </button>
        </form>
      ) : null}

      {isBounced && canReopen ? (
        <form
          action={`/api/ops/orders/${row.orderId}/reopen-for-correction`}
          method="POST"
          className="grid grid-cols-1 gap-2 sm:grid-cols-4"
        >
          <input type="hidden" name="reopenToState" value="TYPING_IN_PROGRESS" />
          <label className="space-y-1 text-xs text-neutral-500">
            Reason
            <select
              name="reason"
              defaultValue={ReopenReason.PV1_REWORK}
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
              Reopen → claim for typing
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

export default async function TypingQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.TYPING_START)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Typing queue</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to access the typing queue. Contact your admin to request
          the <code className="text-neutral-200">typing.start</code> grant (Typist role).
        </p>
      </main>
    );
  }

  const canComplete = hasOperatorPermission(permissions, PERMISSIONS.TYPING_COMPLETE);
  const canStart = hasOperatorPermission(permissions, PERMISSIONS.TYPING_START);
  const canMarkMissingInfo = hasOperatorPermission(
    permissions,
    PERMISSIONS.TYPING_MARK_MISSING_INFO
  );
  const canReopen = hasOperatorPermission(permissions, PERMISSIONS.ORDERS_REOPEN_FOR_CORRECTION);

  // Two buckets because RECEIVED → INBOX and the rest of the
  // typing-stage statuses → TYPING (per BUCKET_CODE_FOR_STATUS). Both
  // are read in a SINGLE tenant transaction (one connection, one
  // BEGIN/GUC/COMMIT) rather than two independent scopes.
  const buckets = await listOrdersInBucketsByCode({
    organizationId: session.tenancy.organizationId,
    bucketCodes: ["INBOX", "TYPING"],
  });
  const inbox = buckets["INBOX"]!;
  const typing = buckets["TYPING"]!;

  const flashKey = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashOrderId = typeof params["orderId"] === "string" ? params["orderId"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;
  const now = Date.now();

  // Partition TYPING rows: in-progress goes above pending/bounced
  // (those are the typist's main work); exception states go in a
  // second list with their own header so the eye can find them.
  const typingActive = typing.rows.filter((r) => r.currentStatus === "TYPING_IN_PROGRESS");
  const typingExceptions = typing.rows.filter((r) => r.currentStatus !== "TYPING_IN_PROGRESS");

  return (
    <main className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Typing queue</h1>
        <p className="text-sm text-neutral-400">
          Typist intake. Claim a new order from the inbox, finish what you&apos;re working, or
          address a PV1 bounce-back / missing-info hold.
        </p>
      </header>

      {flashKey !== null && TYPING_FLASH[flashKey] !== undefined ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          {TYPING_FLASH[flashKey]}{" "}
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

      <section className="space-y-3">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Inbox (ready to claim)
          </h2>
          <span className="text-xs text-neutral-500">{inbox.rows.length} waiting</span>
        </header>
        {!inbox.bucketExists ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
            The INBOX bucket is not provisioned for this organization. Run{" "}
            <code className="text-neutral-200">ProvisionDefaultBuckets</code> to create it.
          </div>
        ) : inbox.rows.length === 0 ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
            Inbox is empty.
          </div>
        ) : (
          <ul className="space-y-3">
            {inbox.rows.map((row) => (
              <QueueRow
                key={row.orderId}
                row={row}
                nowMs={now}
                operatorUserId={session.operator.userId}
                canStart={canStart}
                canComplete={canComplete}
                canMarkMissingInfo={canMarkMissingInfo}
                canReopen={canReopen}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            In progress
          </h2>
          <span className="text-xs text-neutral-500">{typingActive.length} active</span>
        </header>
        {!typing.bucketExists ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
            The TYPING bucket is not provisioned for this organization.
          </div>
        ) : typingActive.length === 0 ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
            No orders in progress.
          </div>
        ) : (
          <ul className="space-y-3">
            {typingActive.map((row) => (
              <QueueRow
                key={row.orderId}
                row={row}
                nowMs={now}
                operatorUserId={session.operator.userId}
                canStart={canStart}
                canComplete={canComplete}
                canMarkMissingInfo={canMarkMissingInfo}
                canReopen={canReopen}
              />
            ))}
          </ul>
        )}
      </section>

      {typingExceptions.length > 0 ? (
        <section className="space-y-3">
          <header className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-amber-400">
              Exceptions (bounce-back / missing info)
            </h2>
            <span className="text-xs text-neutral-500">{typingExceptions.length}</span>
          </header>
          <ul className="space-y-3">
            {typingExceptions.map((row) => (
              <QueueRow
                key={row.orderId}
                row={row}
                nowMs={now}
                operatorUserId={session.operator.userId}
                canStart={canStart}
                canComplete={canComplete}
                canMarkMissingInfo={canMarkMissingInfo}
                canReopen={canReopen}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
