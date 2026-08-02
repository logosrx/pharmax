// Prescriber order visibility (ADR-0033, slice 3).
//
// Lists the signed-in prescriber's own orders — the ones containing
// at least one line they prescribed. The projection is PHI-free
// (rx numbers, drug identity, workflow status, dates; no patient
// fields) — see src/server/portal/provider-orders.ts for the access
// rule and the widening policy.

import { redirect } from "next/navigation";

import { PortalShell } from "../../../src/components/portal/portal-shell.js";
import { getCurrentPortalIdentity } from "../../../src/server/portal/current-session.js";
import { listProviderOrders } from "../../../src/server/portal/provider-orders.js";

const STATUS_LABELS: Readonly<Record<string, string>> = {
  RECEIVED: "Received",
  TYPING_IN_PROGRESS: "In typing",
  TYPING_PENDING_MISSING_INFO: "Awaiting information",
  TYPED_READY_FOR_PV1: "Awaiting pharmacist review",
  PV1_IN_PROGRESS: "Pharmacist review",
  PV1_REJECTED: "Pharmacist review",
  PV1_APPROVED_READY_FOR_FILL: "Preparing",
  FILL_IN_PROGRESS: "Preparing",
  FILL_COMPLETED_READY_FOR_FINAL: "Final verification",
  FINAL_VERIFICATION_IN_PROGRESS: "Final verification",
  FINAL_VERIFICATION_REJECTED: "Final verification",
  FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP: "Preparing to ship",
  READY_TO_SHIP: "Preparing to ship",
  SHIPPED: "Shipped",
  ON_HOLD: "On hold",
  CANCELLED: "Cancelled",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export default async function Page() {
  const identity = await getCurrentPortalIdentity();
  if (identity === null) {
    redirect("/portal/sign-in");
  }

  const page = await listProviderOrders({
    organizationId: identity.session.organizationId,
    providerId: identity.provider.id,
  });

  return (
    <PortalShell active="orders">
      <section className="rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h1 className="text-sm font-semibold text-fg">Your orders</h1>
          <span className="text-xs text-muted">
            {page.totalCount === 1 ? "1 order" : `${page.totalCount} orders`}
            {page.totalCount > page.pageSize ? ` (showing latest ${page.pageSize})` : ""}
          </span>
        </div>

        {page.orders.length === 0 ? (
          <p className="px-6 py-8 text-sm text-muted">
            No orders yet. Orders containing your prescriptions appear here as the pharmacy receives
            them.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {page.orders.map((order) => (
              <li key={order.orderId} className="space-y-2 px-6 py-4">
                <div className="flex items-center justify-between gap-4">
                  <span className="font-mono text-sm text-fg">
                    {order.externalOrderNumber ?? order.orderId.slice(0, 8)}
                  </span>
                  <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-fg">
                    {statusLabel(order.status)}
                  </span>
                </div>
                <div className="text-xs text-muted">
                  Received {order.receivedAt.toLocaleDateString("en-US")}
                  {order.shippedAt !== null
                    ? ` · Shipped ${order.shippedAt.toLocaleDateString("en-US")}`
                    : ""}
                </div>
                <ul className="space-y-1">
                  {order.lines.map((line, index) => (
                    <li key={index} className="text-sm text-fg">
                      <span className="font-mono text-xs text-muted">Rx {line.rxNumber}</span>{" "}
                      {line.drugName}
                      {line.drugStrength !== null ? ` ${line.drugStrength}` : ""} ·{" "}
                      <span className="text-muted">qty {line.quantityToFill}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PortalShell>
  );
}
