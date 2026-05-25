// FedEx derived status code → normalized `ShipmentTrackingEventKind`.
//
// Sourced from FedEx's Track API documentation and the EONPRO
// reference implementation. Each entry maps a 2-letter
// `derivedStatusCode` (returned in `scanEvents[].derivedStatusCode`
// and `latestStatusDetail.code`) to the domain kind we already use
// for EasyPost. This lets a future FedEx tracking poller / webhook
// land events in the same `shipment_tracking_event` table without
// the consumer needing to know the carrier-specific codes.
//
// Unknown codes default to `UNKNOWN` so the row still gets recorded
// for audit and the cached shipment status stays put (the row-store
// command flips status only when the kind maps to a non-null
// `ShipmentStatus`; see `easypost-status.ts.shipmentStatusForTrackingKind`).

import { ShipmentTrackingEventKind } from "@pharmax/database";

const FEDEX_STATUS_MAP: Readonly<Record<string, ShipmentTrackingEventKind>> = Object.freeze({
  // Ready for shipment / label created
  OC: ShipmentTrackingEventKind.CREATED,
  OF: ShipmentTrackingEventKind.CREATED,

  // Picked up — Pharmax treats this as IN_TRANSIT for the cached
  // shipment status (the package has left the building).
  PU: ShipmentTrackingEventKind.IN_TRANSIT,

  // In transit (large bucket — FedEx's intra-network sortation events).
  IT: ShipmentTrackingEventKind.IN_TRANSIT,
  AA: ShipmentTrackingEventKind.IN_TRANSIT,
  AC: ShipmentTrackingEventKind.IN_TRANSIT,
  AD: ShipmentTrackingEventKind.IN_TRANSIT,
  AF: ShipmentTrackingEventKind.IN_TRANSIT,
  AP: ShipmentTrackingEventKind.IN_TRANSIT,
  AR: ShipmentTrackingEventKind.IN_TRANSIT,
  AX: ShipmentTrackingEventKind.IN_TRANSIT,
  CC: ShipmentTrackingEventKind.IN_TRANSIT,
  CP: ShipmentTrackingEventKind.IN_TRANSIT,
  DP: ShipmentTrackingEventKind.IN_TRANSIT,
  DR: ShipmentTrackingEventKind.IN_TRANSIT,
  DS: ShipmentTrackingEventKind.IN_TRANSIT,
  EA: ShipmentTrackingEventKind.IN_TRANSIT,
  ED: ShipmentTrackingEventKind.IN_TRANSIT,
  EO: ShipmentTrackingEventKind.IN_TRANSIT,
  EP: ShipmentTrackingEventKind.IN_TRANSIT,
  FD: ShipmentTrackingEventKind.IN_TRANSIT,
  LO: ShipmentTrackingEventKind.IN_TRANSIT,
  OX: ShipmentTrackingEventKind.IN_TRANSIT,
  PF: ShipmentTrackingEventKind.IN_TRANSIT,
  PL: ShipmentTrackingEventKind.IN_TRANSIT,
  PM: ShipmentTrackingEventKind.IN_TRANSIT,
  SF: ShipmentTrackingEventKind.IN_TRANSIT,
  SP: ShipmentTrackingEventKind.IN_TRANSIT,
  TR: ShipmentTrackingEventKind.IN_TRANSIT,

  // Out for delivery / ready for hold-at-location pickup
  OD: ShipmentTrackingEventKind.OUT_FOR_DELIVERY,
  HL: ShipmentTrackingEventKind.OUT_FOR_DELIVERY,

  // Delivered
  DL: ShipmentTrackingEventKind.DELIVERED,

  // Return to sender
  RS: ShipmentTrackingEventKind.RETURN_TO_SENDER,
  RP: ShipmentTrackingEventKind.RETURN_TO_SENDER,

  // Delivery problems / exceptions
  CA: ShipmentTrackingEventKind.EXCEPTION,
  CD: ShipmentTrackingEventKind.EXCEPTION,
  CH: ShipmentTrackingEventKind.EXCEPTION,
  DD: ShipmentTrackingEventKind.EXCEPTION,
  DE: ShipmentTrackingEventKind.EXCEPTION,
  DY: ShipmentTrackingEventKind.EXCEPTION,
  IX: ShipmentTrackingEventKind.EXCEPTION,
  LP: ShipmentTrackingEventKind.EXCEPTION,
  PD: ShipmentTrackingEventKind.EXCEPTION,
  PX: ShipmentTrackingEventKind.EXCEPTION,
  RC: ShipmentTrackingEventKind.EXCEPTION,
  RD: ShipmentTrackingEventKind.EXCEPTION,
  RG: ShipmentTrackingEventKind.EXCEPTION,
  RM: ShipmentTrackingEventKind.EXCEPTION,
  RR: ShipmentTrackingEventKind.EXCEPTION,
  SE: ShipmentTrackingEventKind.EXCEPTION,
});

/**
 * Normalize a FedEx derived status code (e.g. `"DL"` for delivered)
 * to a `ShipmentTrackingEventKind`. Unknown / undefined codes map to
 * `UNKNOWN` so the event still lands in the audit ledger without
 * advancing the cached shipment status.
 */
export function normalizeFedExStatus(code: string | null | undefined): ShipmentTrackingEventKind {
  if (typeof code !== "string" || code.length === 0) {
    return ShipmentTrackingEventKind.UNKNOWN;
  }
  return FEDEX_STATUS_MAP[code.trim().toUpperCase()] ?? ShipmentTrackingEventKind.UNKNOWN;
}

/**
 * Tracking-number shape predicate. FedEx tracking numbers are 12,
 * 15, 20, or 22 digits. Used by the FedEx tracking poller to filter
 * candidate rows before issuing a Track API call.
 */
export function isFedExTrackingNumber(trackingNumber: string): boolean {
  return /^\d{12}$|^\d{15}$|^\d{20}$|^\d{22}$/.test(trackingNumber.trim());
}
