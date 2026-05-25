// Normalize EasyPost tracker status strings into our domain enums.
//
// EasyPost reports a coarse `status` plus an optional `status_detail`
// on every tracker. Reference:
//   https://docs.easypost.com/docs/trackers#tracker-statuses
//
// The mapping is conservative: anything we don't explicitly recognize
// becomes `UNKNOWN` so the row still lands in the ledger but does not
// flip the shipment's cached status.

import { ShipmentStatus, ShipmentTrackingEventKind } from "@pharmax/database";

const EASYPOST_STATUS_TO_KIND: Readonly<Record<string, ShipmentTrackingEventKind>> = Object.freeze({
  pre_transit: ShipmentTrackingEventKind.CREATED,
  unknown: ShipmentTrackingEventKind.UNKNOWN,
  in_transit: ShipmentTrackingEventKind.IN_TRANSIT,
  out_for_delivery: ShipmentTrackingEventKind.OUT_FOR_DELIVERY,
  delivered: ShipmentTrackingEventKind.DELIVERED,
  available_for_pickup: ShipmentTrackingEventKind.OUT_FOR_DELIVERY,
  return_to_sender: ShipmentTrackingEventKind.RETURN_TO_SENDER,
  failure: ShipmentTrackingEventKind.FAILED_DELIVERY,
  cancelled: ShipmentTrackingEventKind.EXCEPTION,
  error: ShipmentTrackingEventKind.EXCEPTION,
});

const KIND_TO_SHIPMENT_STATUS: Readonly<Record<ShipmentTrackingEventKind, ShipmentStatus | null>> =
  Object.freeze({
    [ShipmentTrackingEventKind.CREATED]: null,
    [ShipmentTrackingEventKind.UNKNOWN]: null,
    [ShipmentTrackingEventKind.IN_TRANSIT]: ShipmentStatus.IN_TRANSIT,
    [ShipmentTrackingEventKind.OUT_FOR_DELIVERY]: ShipmentStatus.OUT_FOR_DELIVERY,
    [ShipmentTrackingEventKind.DELIVERED]: ShipmentStatus.DELIVERED,
    [ShipmentTrackingEventKind.EXCEPTION]: ShipmentStatus.EXCEPTION,
    [ShipmentTrackingEventKind.RETURN_TO_SENDER]: ShipmentStatus.RETURN_TO_SENDER,
    [ShipmentTrackingEventKind.FAILED_DELIVERY]: ShipmentStatus.FAILED_DELIVERY,
  });

/**
 * Normalize an EasyPost tracker status (e.g. `"in_transit"`) into a
 * `ShipmentTrackingEventKind`. Unrecognized values map to
 * `UNKNOWN` so the row still gets recorded for audit.
 */
export function normalizeEasyPostStatus(status: string): ShipmentTrackingEventKind {
  const lower = status.trim().toLowerCase();
  return EASYPOST_STATUS_TO_KIND[lower] ?? ShipmentTrackingEventKind.UNKNOWN;
}

/**
 * Map a normalized tracking event kind to the shipment status the
 * cached column should advance to, or `null` when the kind is an
 * operational signal (e.g. label scanned) that should not change
 * shipment status.
 */
export function shipmentStatusForTrackingKind(
  kind: ShipmentTrackingEventKind
): ShipmentStatus | null {
  return KIND_TO_SHIPMENT_STATUS[kind] ?? null;
}
