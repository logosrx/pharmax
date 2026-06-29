// /ops/shipping — shipping clerk queue.
//
// Lists orders in the SHIPPING bucket with action chrome per substate:
//   - FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP → "Release to ship"
//     (gated ship.release).
//   - READY_TO_SHIP, no shipment → assignee can auto-purchase a label
//     (PurchaseShipmentLabel, gated ship.purchase_label) when the site
//     address + a carrier credential exist, OR record a manual
//     shipment (CreateShipment, gated ship.create).
//   - READY_TO_SHIP, has shipment → "Confirm shipment" (ConfirmShipment,
//     gated ship.confirm) → SHIPPED.
//   - SHIPPED → read-only carrier + tracking display.
//
// PHI: queue surface is non-PHI.

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
import { ALLOWED_CARRIERS_BY_PROVIDER } from "../../../src/server/ops/resolve-purchase-context.js";
import { PageHeader, Section } from "../../../src/components/ui/page.js";
import { Badge, type Tone } from "../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../src/components/ui/feedback.js";
import { Field, Input, Select } from "../../../src/components/ui/field.js";
import { Icon } from "../../../src/components/ui/icon.js";
import { QueueFlash } from "../../../src/components/ops/flash.js";
import { QueueRow, formatAge } from "../../../src/components/ops/queue-row.js";
import { ActionForm, SubmitButton } from "../../../src/components/ops/action-form.js";

const SHIPPING_FLASH: Readonly<Record<string, string>> = {
  released: "Released to shipping. Create a shipment next.",
  shipment_created: "Shipment recorded. Confirm when the carrier picks up.",
  confirmed: "Confirmed — order is SHIPPED.",
};

const CARRIER_OPTIONS: ReadonlyArray<ShipmentCarrier> = [
  ShipmentCarrier.USPS,
  ShipmentCarrier.UPS,
  ShipmentCarrier.FEDEX,
  ShipmentCarrier.DHL,
  ShipmentCarrier.OTHER,
];

function shipmentStatusTone(status: ShipmentStatus): Tone {
  switch (status) {
    case "DELIVERED":
      return "success";
    case "EXCEPTION":
    case "FAILED_DELIVERY":
    case "RETURN_TO_SENDER":
      return "danger";
    case "OUT_FOR_DELIVERY":
      return "info";
    default:
      return "neutral";
  }
}

interface RowProps {
  readonly row: ShippingQueueRow;
  readonly now: Date;
  readonly operatorUserId: string;
  readonly canRelease: boolean;
  readonly canCreate: boolean;
  readonly canConfirm: boolean;
  readonly canPurchase: boolean;
  readonly availableProviders: ReadonlyArray<ShippingProvider>;
  readonly siteAddressComplete: boolean;
}

function ShippingRow({
  row,
  now,
  operatorUserId,
  canRelease,
  canCreate,
  canConfirm,
  canPurchase,
  availableProviders,
  siteAddressComplete,
}: RowProps) {
  const nowMs = now.getTime();
  const isReadyToRelease = row.currentStatus === "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP";
  const isReadyToShip = row.currentStatus === "READY_TO_SHIP";
  const isShipped = row.currentStatus === "SHIPPED";
  const isMine = isReadyToShip && row.currentAssigneeUserId === operatorUserId;
  const otherAssignee = isReadyToShip && !isMine ? row.currentAssigneeUserId : null;
  const hasShipment = row.shipment !== null;

  return (
    <QueueRow
      orderId={row.orderId}
      externalOrderNumber={row.externalOrderNumber}
      priority={row.priority}
      status={row.currentStatus}
      slaDeadlineAt={row.slaDeadlineAt}
      receivedAt={row.receivedAt}
      now={now}
      assigneeUserId={otherAssignee}
    >
      <div className="w-full space-y-3">
        {hasShipment ? (
          <div className="space-y-1 rounded-md border border-line bg-surface-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={shipmentStatusTone(row.shipment!.status)}>{row.shipment!.status}</Badge>
              <span className="text-xs text-muted">
                {row.shipment!.carrier} · {row.shipment!.serviceLevel}
              </span>
            </div>
            <div className="text-xs text-muted">
              Tracking <code className="font-mono text-fg">{row.shipment!.trackingNumber}</code>
            </div>
            {row.shipment!.lastTrackingEventKind !== null ? (
              <div className="text-xs text-subtle">
                Last event: {row.shipment!.lastTrackingEventKind}
                {row.shipment!.lastTrackingEventAt !== null ? (
                  <> · {formatAge(nowMs - row.shipment!.lastTrackingEventAt.getTime())} ago</>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {isReadyToRelease && canRelease ? (
          <ActionForm action={`/api/ops/orders/${row.orderId}/release-to-ship`}>
            <SubmitButton icon="shipping">Release to ship</SubmitButton>
          </ActionForm>
        ) : null}

        {isMine &&
        !hasShipment &&
        canPurchase &&
        siteAddressComplete &&
        availableProviders.length > 0 ? (
          <div className="space-y-2 rounded-md border border-brand/25 bg-brand/5 p-3">
            <div className="text-xs text-iris-200">
              Auto-purchase via carrier broker — from-address from this site, to-address from
              patient PHI, label posted via the chosen provider.
            </div>
            <ActionForm
              action={`/api/ops/orders/${row.orderId}/purchase-shipment-label`}
              className="grid grid-cols-1 gap-3 sm:grid-cols-4"
            >
              <Field label="Provider">
                <Select name="provider" defaultValue={availableProviders[0]}>
                  {availableProviders.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Carrier">
                <Select
                  name="carrier"
                  defaultValue={ALLOWED_CARRIERS_BY_PROVIDER[availableProviders[0]!]?.[0]}
                >
                  {Array.from(
                    new Set(
                      availableProviders.flatMap((p) => ALLOWED_CARRIERS_BY_PROVIDER[p] ?? [])
                    )
                  ).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Service level" className="sm:col-span-2">
                <Input
                  type="text"
                  name="serviceLevel"
                  required
                  placeholder="PRIORITY, FEDEX_GROUND, UPS_GROUND"
                />
              </Field>
              <div className="sm:col-span-4">
                <SubmitButton icon="package">Auto-purchase label</SubmitButton>
              </div>
            </ActionForm>
          </div>
        ) : null}

        {isMine && !hasShipment && canCreate ? (
          <div className="space-y-2">
            <div className="text-xs text-subtle">
              Or — print the carrier label outside our system, then record the tracking number here.
              {!siteAddressComplete ? (
                <>
                  {" "}
                  Auto-purchase needs this site&apos;s ship-from address on{" "}
                  <code>/ops/admin/sites</code>.
                </>
              ) : null}
              {availableProviders.length === 0 ? (
                <>
                  {" "}
                  Auto-purchase needs a carrier credential on <code>/ops/admin/carriers</code>.
                </>
              ) : null}
            </div>
            <ActionForm
              action={`/api/ops/orders/${row.orderId}/create-shipment`}
              className="grid grid-cols-1 gap-3 sm:grid-cols-4"
            >
              <Field label="Carrier">
                <Select name="carrier" defaultValue={ShipmentCarrier.USPS}>
                  {CARRIER_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Service level">
                <Input type="text" name="serviceLevel" required placeholder="PRIORITY" />
              </Field>
              <Field label="Tracking number" className="sm:col-span-2">
                <Input
                  type="text"
                  name="trackingNumber"
                  required
                  autoComplete="off"
                  className="font-mono"
                  placeholder="9400 1112 0250 9999 9999 99"
                />
              </Field>
              <div className="sm:col-span-4">
                <SubmitButton icon="shipping">Create shipment</SubmitButton>
              </div>
            </ActionForm>
          </div>
        ) : null}

        {isMine && hasShipment && canConfirm ? (
          <ActionForm action={`/api/ops/orders/${row.orderId}/confirm-shipment`}>
            <SubmitButton variant="go" icon="check">
              Confirm shipment → SHIPPED
            </SubmitButton>
          </ActionForm>
        ) : null}

        {isShipped && hasShipment && row.shipment!.confirmedAt !== null ? (
          <div className="flex items-center gap-1.5 text-xs text-subtle">
            <Icon name="check" size={12} className="text-emerald-400" />
            Shipped {formatAge(nowMs - row.shipment!.confirmedAt.getTime())} ago
          </div>
        ) : null}
      </div>
    </QueueRow>
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
      <div className="space-y-6">
        <PageHeader eyebrow="Fulfillment" title="Shipping queue" />
        <PermissionDenied grant="ship.release" role="Shipping Clerk" />
      </div>
    );
  }

  const canRelease = hasOperatorPermission(permissions, PERMISSIONS.SHIP_RELEASE);
  const canCreate = hasOperatorPermission(permissions, PERMISSIONS.SHIP_CREATE);
  const canConfirm = hasOperatorPermission(permissions, PERMISSIONS.SHIP_CONFIRM);
  const canPurchase = hasOperatorPermission(permissions, PERMISSIONS.SHIP_PURCHASE_LABEL);

  const { queue, availableProviders, sites } = await loadShippingQueuePageData({
    organizationId: session.tenancy.organizationId,
  });
  const siteAddressCompleteById = new Map(sites.map((s) => [s.siteId, s.addressComplete]));
  const now = new Date();

  const active = queue.rows.filter((r) => r.currentStatus !== "SHIPPED");
  const shipped = queue.rows.filter((r) => r.currentStatus === "SHIPPED");

  const rowProps = {
    now,
    operatorUserId: session.operator.userId,
    canRelease,
    canCreate,
    canConfirm,
    canPurchase,
    availableProviders,
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Fulfillment"
        title="Shipping queue"
        description="Release final-verified orders, record shipments, and confirm carrier hand-off."
      />

      <QueueFlash params={params} messages={SHIPPING_FLASH} />

      <Section title="Needs action" count={active.length}>
        {!queue.bucketExists ? (
          <Banner tone="warning" title="SHIPPING bucket not provisioned">
            Run <code>ProvisionDefaultBuckets</code> to create it for this organization.
          </Banner>
        ) : active.length === 0 ? (
          <EmptyState
            icon="shipping"
            title="No orders waiting on shipping"
            description="Final-verified orders land here for release and carrier hand-off."
          />
        ) : (
          <ul className="space-y-3">
            {active.map((row) => (
              <li key={row.orderId}>
                <ShippingRow
                  row={row}
                  {...rowProps}
                  siteAddressComplete={siteAddressCompleteById.get(row.siteId) ?? false}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {shipped.length > 0 ? (
        <Section title="Recently shipped" count={shipped.length}>
          <ul className="space-y-3">
            {shipped.map((row) => (
              <li key={row.orderId}>
                <ShippingRow
                  row={row}
                  {...rowProps}
                  siteAddressComplete={siteAddressCompleteById.get(row.siteId) ?? false}
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
