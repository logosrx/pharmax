// /ops/fill/[orderId] — pharmacy tech FILL workbench.
//
// One-screen surface for the assigned tech. Renders:
//
//   - Order header (external order #, current status, version)
//   - Workstation picker (URL-pinned `?workstation=<id>`) — every
//     print form submits the selected workstation id, which the
//     route validates is at the order's site before threading it
//     into the tenancy. PrintVialLabel `requiresWorkstation:
//     true`, so this is the gate.
//   - Per line:
//       - Drug / qty / rx
//       - Lot status: Not assigned → dropdown of candidate lots
//         (filtered by NDC + site + active + unexpired) + Assign;
//         OR "Assigned: <lotNumber>" if already done.
//       - Vial-label status: Not printed → printer dropdown +
//         Print; OR "Printed (PENDING/SENT/COMPLETED)".
//   - Whole-order: when every line has a lot + a vial label, a
//     "Complete fill" form opens with per-line `lotScan` +
//     `vialLabelScan` inputs that submit to CompleteFill (the
//     command runs scan validation against the assigned lot
//     barcode + vial label barcode; mismatch returns a typed scan
//     error code).
//
// Permission gates:
//   - Page visibility: `fill.start`
//   - Assign: `fill.assign_lot`
//   - Print: `fill.print_vial_label`
//   - Complete: `fill.complete`
//
// Only the order's assignee can ACT on it (command bus enforces
// via assignee guards). The page surfaces forms only when isMine;
// non-assignees see a read-only workbench.
//
// PHI: same rule as the fill queue — workbench is non-PHI. The
// /ops/orders/[id] page is where the sig + patient details are
// read. A future enhancement may inline the decrypted sig per line.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { getFillWorkbench } from "../../../../src/server/ops/get-fill-workbench.js";

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default async function FillWorkbenchPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ orderId }, sp] = await Promise.all([params, searchParams]);
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.FILL_START)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Fill workbench</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to access the fill workbench. Contact your admin to request
          the <code className="text-neutral-200">fill.start</code> grant.
        </p>
      </main>
    );
  }

  const canAssign = hasOperatorPermission(permissions, PERMISSIONS.FILL_ASSIGN_LOT);
  const canPrint = hasOperatorPermission(permissions, PERMISSIONS.FILL_PRINT_VIAL_LABEL);
  const canComplete = hasOperatorPermission(permissions, PERMISSIONS.FILL_COMPLETE);

  const workbench = await getFillWorkbench({
    organizationId: session.tenancy.organizationId,
    orderId,
  });

  if (workbench === null) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Order not found</h1>
        <p className="text-neutral-400">
          <Link href="/ops/fill" className="text-blue-400 hover:underline">
            Back to fill queue
          </Link>
        </p>
      </main>
    );
  }

  const isMine = workbench.currentAssigneeUserId === session.operator.userId;
  const inProgress = workbench.currentStatus === "FILL_IN_PROGRESS";
  const flashError = typeof sp["error"] === "string" ? sp["error"] : null;
  const flashKey = typeof sp["flash"] === "string" ? sp["flash"] : null;
  const flashLineId = typeof sp["lineId"] === "string" ? sp["lineId"] : null;

  // Workstation selection: URL-pinned. Default to first available
  // if the operator hasn't picked yet. The form below offers a
  // "Switch workstation" pulldown — clicking it just changes the
  // query string and re-renders; no commands are dispatched.
  const requestedWs = typeof sp["workstation"] === "string" ? sp["workstation"] : null;
  const workstationIsValid =
    requestedWs !== null &&
    workbench.availableWorkstations.some((w) => w.workstationId === requestedWs);
  const activeWorkstationId = workstationIsValid
    ? requestedWs
    : (workbench.availableWorkstations[0]?.workstationId ?? null);

  return (
    <main className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/ops/fill" className="text-sm text-blue-400 hover:underline">
          ← Back to fill queue
        </Link>
        <Link
          href={`/ops/orders/${workbench.orderId}`}
          className="text-sm text-blue-400 hover:underline"
        >
          View order detail (patient + sig) →
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-mono text-2xl font-semibold text-neutral-50">
            {workbench.externalOrderNumber ?? workbench.orderId}
          </h1>
          <div className="text-xs text-neutral-500">
            {workbench.currentStatus} · v{workbench.version}
            {workbench.currentAssigneeUserId !== null ? (
              <>
                {" · "}assignee{" "}
                <code className="text-neutral-300">{workbench.currentAssigneeUserId}</code>
              </>
            ) : null}
          </div>
        </div>
      </header>

      {flashError !== null ? (
        <div className="rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200">
          {flashError}
        </div>
      ) : null}
      {flashKey !== null ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          {flashKey}
          {flashLineId !== null ? (
            <>
              {" "}
              for line <code className="font-mono">{flashLineId}</code>
            </>
          ) : null}
        </div>
      ) : null}

      {!inProgress ? (
        <div className="rounded-md border border-amber-800 bg-amber-950 px-4 py-3 text-sm text-amber-200">
          This order is not in FILL_IN_PROGRESS — workbench actions are inactive. Status:{" "}
          <code className="font-mono">{workbench.currentStatus}</code>
        </div>
      ) : null}
      {inProgress && !isMine ? (
        <div className="rounded-md border border-amber-800 bg-amber-950 px-4 py-3 text-sm text-amber-200">
          You are not the assignee — workbench is read-only. The assignee must complete the fill, or
          release the order back to FILL.
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Workstation
        </h2>
        {workbench.availableWorkstations.length === 0 ? (
          <div className="rounded-md border border-red-800 bg-red-950 p-4 text-sm text-red-200">
            No active workstations are configured at this site. Print actions will fail. An admin
            must register a workstation for this site before fills can be printed.
          </div>
        ) : (
          <form method="GET" className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-neutral-500" htmlFor="workstation-select">
              Active workstation (used for print actions on this page):
            </label>
            <select
              id="workstation-select"
              name="workstation"
              defaultValue={activeWorkstationId ?? ""}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
            >
              {workbench.availableWorkstations.map((w) => (
                <option key={w.workstationId} value={w.workstationId}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              Switch
            </button>
          </form>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Prescription lines
        </h2>
        <ul className="space-y-3">
          {workbench.lines.map((line, idx) => {
            const hasLot = line.assignedLot !== null;
            const hasLabel = line.vialLabel !== null;
            return (
              <li
                key={line.orderLineId}
                className="space-y-3 rounded-md border border-neutral-800 bg-neutral-950 p-4"
              >
                <header className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs text-neutral-500">
                      Line {idx + 1} · NDC{" "}
                      <code className="font-mono text-neutral-400">{line.drugNdc}</code> · Rx{" "}
                      <code className="font-mono text-neutral-400">{line.rxNumber}</code>
                    </div>
                    <div className="text-base text-neutral-100">
                      {line.drugName}
                      {line.drugStrength !== null ? ` ${line.drugStrength}` : ""}
                      {" · qty "}
                      <span className="font-mono">{line.quantityToFill}</span>
                    </div>
                  </div>
                </header>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <div className="text-xs text-neutral-500">Lot</div>
                    {hasLot ? (
                      <div className="text-sm text-neutral-100">
                        Assigned · <span className="font-mono">{line.assignedLot!.lotNumber}</span>
                      </div>
                    ) : isMine && canAssign && inProgress ? (
                      line.candidateLots.length === 0 ? (
                        <div className="text-sm text-amber-300">
                          No active, unexpired lots for NDC {line.drugNdc} at this site. Receive
                          inventory before continuing.
                        </div>
                      ) : (
                        <form
                          action={`/api/ops/orders/${workbench.orderId}/assign-lot`}
                          method="POST"
                          className="flex flex-wrap items-center gap-2"
                        >
                          <input type="hidden" name="orderLineId" value={line.orderLineId} />
                          <label className="sr-only" htmlFor={`lot-${line.orderLineId}`}>
                            Lot
                          </label>
                          <select
                            id={`lot-${line.orderLineId}`}
                            name="lotId"
                            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
                            defaultValue={line.candidateLots[0]?.lotId}
                          >
                            {line.candidateLots.map((lot) => (
                              <option key={lot.lotId} value={lot.lotId}>
                                {lot.lotNumber} (exp {formatDate(lot.expirationDate)})
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
                          >
                            Assign lot
                          </button>
                        </form>
                      )
                    ) : (
                      <div className="text-sm text-neutral-500">Not assigned.</div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs text-neutral-500">Vial label</div>
                    {hasLabel ? (
                      <div className="text-sm text-neutral-100">
                        {line.vialLabel!.latestPrintJobStatus ?? "—"} ·{" "}
                        <code className="font-mono text-xs text-neutral-400">
                          {line.vialLabel!.barcodeValue}
                        </code>
                      </div>
                    ) : isMine && canPrint && inProgress ? (
                      !hasLot ? (
                        <div className="text-sm text-neutral-500">Assign a lot first.</div>
                      ) : workbench.availablePrinters.length === 0 ? (
                        <div className="text-sm text-amber-300">
                          No active label printers at this site.
                        </div>
                      ) : activeWorkstationId === null ? (
                        <div className="text-sm text-amber-300">
                          Select a workstation above before printing.
                        </div>
                      ) : (
                        <form
                          action={`/api/ops/orders/${workbench.orderId}/print-vial-label`}
                          method="POST"
                          className="flex flex-wrap items-center gap-2"
                        >
                          <input type="hidden" name="orderLineId" value={line.orderLineId} />
                          <input type="hidden" name="workstationId" value={activeWorkstationId} />
                          <label className="sr-only" htmlFor={`printer-${line.orderLineId}`}>
                            Printer
                          </label>
                          <select
                            id={`printer-${line.orderLineId}`}
                            name="printerId"
                            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
                            defaultValue={workbench.availablePrinters[0]?.printerId}
                          >
                            {workbench.availablePrinters.map((p) => (
                              <option key={p.printerId} value={p.printerId}>
                                {p.code} — {p.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
                          >
                            Print vial label
                          </button>
                        </form>
                      )
                    ) : (
                      <div className="text-sm text-neutral-500">Not printed.</div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {isMine && inProgress && canComplete ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Scan to complete
          </h2>
          {!workbench.readyForCompletionScans ? (
            <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-400">
              Every line needs an assigned lot AND a printed vial label before you can scan to
              complete.
            </div>
          ) : (
            <form
              action={`/api/ops/orders/${workbench.orderId}/complete-fill`}
              method="POST"
              className="space-y-3 rounded-md border border-neutral-800 bg-neutral-950 p-4"
            >
              {workbench.lines.map((line, idx) => (
                <div
                  key={line.orderLineId}
                  className="space-y-2 border-b border-neutral-800 pb-3 last:border-b-0 last:pb-0"
                >
                  <div className="text-xs text-neutral-500">
                    Line {idx + 1} · {line.drugName}
                  </div>
                  <input
                    type="hidden"
                    name={`lineScans[${idx}][orderLineId]`}
                    value={line.orderLineId}
                  />
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-xs text-neutral-500">
                      Lot scan
                      <input
                        type="text"
                        name={`lineScans[${idx}][lotScan]`}
                        autoComplete="off"
                        required
                        className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
                        placeholder="(scan lot barcode)"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-neutral-500">
                      Vial label scan
                      <input
                        type="text"
                        name={`lineScans[${idx}][vialLabelScan]`}
                        autoComplete="off"
                        required
                        className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
                        placeholder="(scan printed vial label)"
                      />
                    </label>
                  </div>
                </div>
              ))}
              <button
                type="submit"
                className="rounded-md border border-emerald-700 bg-emerald-900 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-800"
              >
                Complete fill (scan-validate all lines)
              </button>
            </form>
          )}
        </section>
      ) : null}
    </main>
  );
}
