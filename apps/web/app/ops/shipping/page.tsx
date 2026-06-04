// /ops/shipping — shipping clerk queue.
//
// Closes the operator-visible workflow loop. Lists orders in the
// SHIPPING bucket with inline action chrome per substate:
//
//   - FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP → "Release to ship"
//     button (gated `ship.release`). On success the order moves to
//     READY_TO_SHIP and the operator becomes the assignee.
//
//   - READY_TO_SHIP, no shipment → assignee can EITHER create a
//     shipment by typing carrier + service + tracking number (the
//     "I printed the label outside our system" path, dispatched
//     to CreateShipment, gated `ship.create`); the auto-purchase
//     path (PurchaseShipmentLabel) is deferred until the
//     ship-from address admin slice lands and is NOT surfaced
//     here.
//
//   - READY_TO_SHIP, has shipment → assignee can "Confirm shipment"
//     (the physical hand-off to the carrier, dispatched to
//     ConfirmShipment, gated `ship.confirm`). On success the
//     order transitions to SHIPPED (terminal); shipment.confirmedAt
//     is stamped and the cached carrier tracking starts streaming
//     via the tracking pollers / EasyPost webhook.
//
//   - SHIPPED → read-only carrier + tracking display, plus latest
//     known tracking event from the cached fields on `Shipment`.
//
// PHI: queue surface is non-PHI. The order-detail page is the
// PHI-decrypting read.

import Link from "next/link";

import { ShipmentCarrier, type ShipmentStatus, type ShippingProvider } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import {
  loadShippingQueuePageData,
  type ShippingQueueRow,
} from "../../../src/server/ops/list-shipping-queue.js";
import { SlaBadge, slaRowBorderClass, slaStatusFor } from "../../../src/components/sla-badge.js";
import { ALLOWED_CARRIERS_BY_PROVIDER } from "../../../src/server/ops/resolve-purchase-context.js";

const SHIPPING_FLASH: Readonly<Record<string, string>> = {
  released: "Released to shipping. Create a shipment next.",
  shipment_created: "Shipment recorded. Confirm when the carrier picks up.",
  confirmed: "Confirmed. Order is SHIPPED.",
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

function shipmentStatusBadgeClass(status: ShipmentStatus): string {
  switch (status) {
    case "DELIVERED":
      return "border-emerald-700 bg-emerald-950 text-emerald-200";
    case "EXCEPTION":
    case "FAILED_DELIVERY":
    case "RETURN_TO_SENDER":
      return "border-red-700 bg-red-950 text-red-200";
    case "OUT_FOR_DELIVERY":
      return "border-blue-700 bg-blue-950 text-blue-200";
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-300";
  }
}

interface RowProps {
  readonly row: ShippingQueueRow;
  readonly nowMs: number;
  readonly operatorUserId: string;
  readonly canRelease: boolean;
  readonly canCreate: boolean;
  readonly canConfirm: boolean;
  readonly canPurchase: boolean;
  /** Providers for which the org has an ACTIVE carrier credential. */
  readonly availableProviders: ReadonlyArray<ShippingProvider>;
  /** Whether the order's pharmacy site has a complete ship-from address. */
  readonly siteAddressComplete: boolean;
}

const CARRIER_OPTIONS: ReadonlyArray<ShipmentCarrier> = [
  ShipmentCarrier.USPS,
  ShipmentCarrier.UPS,
  ShipmentCarrier.FEDEX,
  ShipmentCarrier.DHL,
  ShipmentCarrier.OTHER,
];

function QueueRow({
  row,
  nowMs,
  operatorUserId,
  canRelease,
  canCreate,
  canConfirm,
  canPurchase,
  availableProviders,
  siteAddressComplete,
}: RowProps) {
  const ageMs = nowMs - row.receivedAt.getTime();
  const nowDate = new Date(nowMs);
  const slaStatus = slaStatusFor(row.slaDeadlineAt, nowDate);
  const isReadyToRelease = row.currentStatus === "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP";
  const isReadyToShip = row.currentStatus === "READY_TO_SHIP";
  const isShipped = row.currentStatus === "SHIPPED";
  const isMine = isReadyToShip && row.currentAssigneeUserId === operatorUserId;
  const otherAssignee =
    isReadyToShip &&
    row.currentAssigneeUserId !== null &&
    row.currentAssigneeUserId !== operatorUserId;
  const hasShipment = row.shipment !== null;

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
            <span className="text-xs text-neutral-500">{row.currentStatus}</span>
            <SlaBadge slaDeadlineAt={row.slaDeadlineAt} now={nowDate} />
          </div>
          <div className="text-xs text-neutral-500">Received {formatDuration(ageMs)} ago</div>
          {otherAssignee ? (
            <div className="text-xs text-neutral-500">
              Claimed by <code className="text-neutral-300">{row.currentAssigneeUserId}</code>
            </div>
          ) : null}
        </div>
      </div>

      {hasShipment ? (
        <div className="space-y-1 rounded-md border border-neutral-800 bg-neutral-900 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${shipmentStatusBadgeClass(
                row.shipment!.status
              )}`}
            >
              {row.shipment!.status}
            </span>
            <span className="text-xs text-neutral-400">
              {row.shipment!.carrier} · {row.shipment!.serviceLevel}
            </span>
          </div>
          <div className="text-xs text-neutral-300">
            Tracking:{" "}
            <code className="font-mono text-neutral-100">{row.shipment!.trackingNumber}</code>
          </div>
          {row.shipment!.lastTrackingEventKind !== null ? (
            <div className="text-xs text-neutral-500">
              Last event: {row.shipment!.lastTrackingEventKind}
              {row.shipment!.lastTrackingEventAt !== null ? (
                <> · {formatDuration(nowMs - row.shipment!.lastTrackingEventAt.getTime())} ago</>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {isReadyToRelease && canRelease ? (
        <form
          action={`/api/ops/orders/${row.orderId}/release-to-ship`}
          method="POST"
          className="flex flex-wrap items-center gap-2"
        >
          <button
            type="submit"
            className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
          >
            Release to ship
          </button>
        </form>
      ) : null}

      {isMine &&
      !hasShipment &&
      canPurchase &&
      siteAddressComplete &&
      availableProviders.length > 0 ? (
        <div className="space-y-2 rounded-md border border-blue-900 bg-blue-950/30 p-3">
          <div className="text-xs text-blue-300">
            Auto-purchase via carrier broker. We&apos;ll resolve the from-address from this site,
            the to-address from the patient PHI, and post-purchase a label via the chosen provider.
          </div>
          <form
            action={`/api/ops/orders/${row.orderId}/purchase-shipment-label`}
            method="POST"
            className="grid grid-cols-1 gap-2 sm:grid-cols-4"
          >
            <label className="space-y-1 text-xs text-neutral-500">
              Provider
              <select
                name="provider"
                defaultValue={availableProviders[0]}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              >
                {availableProviders.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              Carrier
              <select
                name="carrier"
                defaultValue={ALLOWED_CARRIERS_BY_PROVIDER[availableProviders[0]!]?.[0]}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              >
                {/* Union of carriers across all available providers; the
                    server-side route re-validates against the chosen
                    provider's allow-list. */}
                {Array.from(
                  new Set(availableProviders.flatMap((p) => ALLOWED_CARRIERS_BY_PROVIDER[p] ?? []))
                ).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-neutral-500 sm:col-span-2">
              Service level
              <input
                type="text"
                name="serviceLevel"
                required
                placeholder="e.g. PRIORITY, FEDEX_GROUND, UPS_GROUND"
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              />
            </label>
            <div className="sm:col-span-4">
              <button
                type="submit"
                className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
              >
                Auto-purchase label
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {isMine && !hasShipment && canCreate ? (
        <div className="space-y-2">
          <div className="text-xs text-neutral-500">
            Or — print the carrier label outside our system, then record the tracking number here
            manually.
            {!siteAddressComplete ? (
              <>
                {" "}
                Auto-purchase is unavailable until this site&apos;s ship-from address is set on{" "}
                <code className="text-neutral-300">/ops/admin/sites</code>.
              </>
            ) : null}
            {availableProviders.length === 0 ? (
              <>
                {" "}
                Auto-purchase is unavailable until at least one carrier credential is registered on{" "}
                <code className="text-neutral-300">/ops/admin/carriers</code>.
              </>
            ) : null}
          </div>
          <form
            action={`/api/ops/orders/${row.orderId}/create-shipment`}
            method="POST"
            className="grid grid-cols-1 gap-2 sm:grid-cols-4"
          >
            <label className="space-y-1 text-xs text-neutral-500">
              Carrier
              <select
                name="carrier"
                defaultValue={ShipmentCarrier.USPS}
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              >
                {CARRIER_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-neutral-500">
              Service level
              <input
                type="text"
                name="serviceLevel"
                required
                placeholder="e.g. PRIORITY"
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
              />
            </label>
            <label className="space-y-1 text-xs text-neutral-500 sm:col-span-2">
              Tracking number
              <input
                type="text"
                name="trackingNumber"
                required
                autoComplete="off"
                placeholder="e.g. 9400111202509999999999"
                className="block w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100"
              />
            </label>
            <div className="sm:col-span-4">
              <button
                type="submit"
                className="rounded-md border border-blue-700 bg-blue-900 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-800"
              >
                Create shipment
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {isMine && hasShipment && canConfirm ? (
        <form
          action={`/api/ops/orders/${row.orderId}/confirm-shipment`}
          method="POST"
          className="flex flex-wrap items-center gap-2"
        >
          <button
            type="submit"
            className="rounded-md border border-emerald-700 bg-emerald-900 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-800"
          >
            Confirm shipment → SHIPPED
          </button>
        </form>
      ) : null}

      {isShipped && hasShipment ? (
        <div className="text-xs text-neutral-500">
          Shipped{" "}
          {row.shipment!.confirmedAt !== null ? (
            <>{formatDuration(nowMs - row.shipment!.confirmedAt.getTime())} ago</>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default async function ShippingQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.SHIP_RELEASE)) {
    return (
      <main className="space-y-3">
        <h1 className="text-2xl font-semibold text-neutral-50">Shipping queue</h1>
        <p className="text-neutral-400">
          You don&apos;t have permission to access the shipping queue. Contact your admin to request
          the <code className="text-neutral-200">ship.release</code> grant (Shipping Clerk role).
        </p>
      </main>
    );
  }

  const canRelease = hasOperatorPermission(permissions, PERMISSIONS.SHIP_RELEASE);
  const canCreate = hasOperatorPermission(permissions, PERMISSIONS.SHIP_CREATE);
  const canConfirm = hasOperatorPermission(permissions, PERMISSIONS.SHIP_CONFIRM);
  const canPurchase = hasOperatorPermission(permissions, PERMISSIONS.SHIP_PURCHASE_LABEL);

  // All three reads share ONE tenant transaction / connection instead
  // of three concurrent scopes (see loadShippingQueuePageData).
  const { queue, availableProviders, sites } = await loadShippingQueuePageData({
    organizationId: session.tenancy.organizationId,
  });

  const siteAddressCompleteById = new Map(sites.map((s) => [s.siteId, s.addressComplete]));

  const flashKey = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashOrderId = typeof params["orderId"] === "string" ? params["orderId"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;
  const now = Date.now();

  // Partition rows into "needs work" + "shipped" so the operator
  // eye finds active rows at the top. Within "needs work" the
  // original queue-scanner sort (priority × SLA × age) is preserved.
  const active = queue.rows.filter((r) => r.currentStatus !== "SHIPPED");
  const shipped = queue.rows.filter((r) => r.currentStatus === "SHIPPED");

  return (
    <main className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-50">Shipping queue</h1>
        <p className="text-sm text-neutral-400">
          Shipping clerk surface. Release final-verified orders, record shipments, and confirm
          carrier hand-off.
        </p>
      </header>

      {flashKey !== null && SHIPPING_FLASH[flashKey] !== undefined ? (
        <div className="rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-200">
          {SHIPPING_FLASH[flashKey]}{" "}
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
            Needs action
          </h2>
          <span className="text-xs text-neutral-500">{active.length} active</span>
        </header>
        {!queue.bucketExists ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
            The SHIPPING bucket is not provisioned for this organization. Run{" "}
            <code className="text-neutral-200">ProvisionDefaultBuckets</code> to create it.
          </div>
        ) : active.length === 0 ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
            No orders waiting on shipping.
          </div>
        ) : (
          <ul className="space-y-3">
            {active.map((row) => (
              <QueueRow
                key={row.orderId}
                row={row}
                nowMs={now}
                operatorUserId={session.operator.userId}
                canRelease={canRelease}
                canCreate={canCreate}
                canConfirm={canConfirm}
                canPurchase={canPurchase}
                availableProviders={availableProviders}
                siteAddressComplete={siteAddressCompleteById.get(row.siteId) ?? false}
              />
            ))}
          </ul>
        )}
      </section>

      {shipped.length > 0 ? (
        <section className="space-y-3">
          <header className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
              Recently shipped
            </h2>
            <span className="text-xs text-neutral-500">{shipped.length}</span>
          </header>
          <ul className="space-y-3">
            {shipped.map((row) => (
              <QueueRow
                key={row.orderId}
                row={row}
                nowMs={now}
                operatorUserId={session.operator.userId}
                canRelease={canRelease}
                canCreate={canCreate}
                canConfirm={canConfirm}
                canPurchase={canPurchase}
                availableProviders={availableProviders}
                siteAddressComplete={siteAddressCompleteById.get(row.siteId) ?? false}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
