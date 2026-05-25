// UPS Track API status → normalized `ShipmentTrackingEventKind`.
//
// UPS exposes status on `Package.currentStatus.type` (single-letter
// or 2-char code). The map covers the documented values; unknown
// types default to `UNKNOWN` so the row still lands in the ledger
// without advancing the cached shipment status (same convention as
// the EasyPost + FedEx normalizers).
//
// Reference: UPS Tracking API v1 documentation — Package.currentStatus
// and the per-activity Status.Type vocabulary.

import { ShipmentTrackingEventKind } from "@pharmax/database";

const UPS_STATUS_MAP: Readonly<Record<string, ShipmentTrackingEventKind>> = Object.freeze({
  // Manifest pickup / label created (origin scan)
  M: ShipmentTrackingEventKind.CREATED,
  MV: ShipmentTrackingEventKind.CREATED,

  // In transit
  I: ShipmentTrackingEventKind.IN_TRANSIT,
  P: ShipmentTrackingEventKind.IN_TRANSIT,

  // Out for delivery
  O: ShipmentTrackingEventKind.OUT_FOR_DELIVERY,

  // Delivered
  D: ShipmentTrackingEventKind.DELIVERED,

  // Returned to shipper
  RS: ShipmentTrackingEventKind.RETURN_TO_SENDER,

  // Exception / delivery problem
  X: ShipmentTrackingEventKind.EXCEPTION,
  NA: ShipmentTrackingEventKind.EXCEPTION,
});

/**
 * Normalize a UPS status type (e.g. `"D"` for delivered) to a
 * `ShipmentTrackingEventKind`. Unknown / undefined types map to
 * `UNKNOWN` so the event still lands in the audit ledger without
 * advancing the cached shipment status.
 */
export function normalizeUpsStatus(type: string | null | undefined): ShipmentTrackingEventKind {
  if (typeof type !== "string" || type.length === 0) {
    return ShipmentTrackingEventKind.UNKNOWN;
  }
  return UPS_STATUS_MAP[type.trim().toUpperCase()] ?? ShipmentTrackingEventKind.UNKNOWN;
}

/**
 * UPS canonical tracking number shape predicate.
 *
 * The most common production format is `1Z` followed by 16
 * alphanumerics (case-insensitive). Mail Innovations and reference-
 * number formats exist but the poller filters them out at the
 * carrier-resolution layer — only the canonical 1Z format is safe to
 * round-trip through the UPS Track API without a separate carrier
 * hint.
 */
export function isUpsTrackingNumber(trackingNumber: string): boolean {
  return /^1Z[A-Z0-9]{16}$/i.test(trackingNumber.trim());
}
