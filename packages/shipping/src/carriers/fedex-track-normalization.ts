// Shared normalization of FedEx track results into dispatchable
// tracking events.
//
// Two ingestion channels produce FedEx tracking data:
//
//   1. The polling worker (`apps/worker` FedEx tracking poller),
//      which calls the Track API on a schedule.
//   2. The Advanced Integrated Visibility webhook receiver, which
//      gets near real-time pushes of the same trackResult shape.
//
// Both channels MUST normalize identically — same `externalEventId`
// derivation, same status mapping, same location extraction — so a
// webhook push and a poll describing the same physical scan collide
// on the `(organizationId, source, externalEventId)` unique
// constraint and deduplicate instead of double-writing the ledger.
// That invariant is why this module lives in `@pharmax/shipping`
// and not in the worker.

import type { ShipmentTrackingEventKind } from "@pharmax/database";

import type { FedExScanEvent, FedExTrackResult } from "./fedex-client.js";
import { normalizeFedExStatus } from "./fedex-status.js";

// `dateAndTimes` entry types that represent something that actually
// HAPPENED. `ESTIMATED_DELIVERY` (and any other forward-looking
// estimate) must never be used as an event's `occurredAt` — a
// first-entry heuristic could stamp a tracking event with a date in
// the future, corrupting transit-time reports.
const ACTUAL_DATE_TYPES: ReadonlyArray<string> = ["ACTUAL_DELIVERY", "ACTUAL_PICKUP", "SHIP"];

export function parseFedExDate(value: string | undefined): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function pickOccurredAt(result: FedExTrackResult): Date | null {
  for (const type of ACTUAL_DATE_TYPES) {
    const entry = result.dateAndTimes?.find((d) => d.type === type);
    const parsed = parseFedExDate(entry?.dateTime);
    if (parsed !== null) {
      return parsed;
    }
  }
  // Fall back to the latest scanEvent's date (FedEx returns scans
  // newest-first).
  return parseFedExDate(result.scanEvents?.[0]?.date);
}

/**
 * The carrier's current delivery estimate for this track result.
 * Kept separate from `occurredAt` — it is a forecast, not an event.
 */
export function pickEstimatedDeliveryAt(result: FedExTrackResult): Date | null {
  const entry = result.dateAndTimes?.find((d) => d.type === "ESTIMATED_DELIVERY");
  return parseFedExDate(entry?.dateTime);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * One tracking event ready for `RecordShipmentTrackingEvent`
 * dispatch — either a single FedEx scan or the latest-status
 * fallback when a track result carries no scans.
 */
export interface NormalizedFedExTrackingEvent {
  readonly externalEventId: string;
  readonly kind: ShipmentTrackingEventKind;
  readonly carrierStatus: string;
  readonly carrierStatusDetail: string | null;
  readonly occurredAt: Date;
  readonly scanCity: string | null;
  readonly scanStateOrProvince: string | null;
  readonly scanCountry: string | null;
  readonly rawPayload: Record<string, unknown>;
}

function scanLocationFields(location: FedExScanEvent["scanLocation"]): {
  scanCity: string | null;
  scanStateOrProvince: string | null;
  scanCountry: string | null;
} {
  return {
    scanCity:
      typeof location?.city === "string" && location.city.length > 0
        ? truncate(location.city, 64)
        : null,
    scanStateOrProvince:
      typeof location?.stateOrProvinceCode === "string" && location.stateOrProvinceCode.length > 0
        ? truncate(location.stateOrProvinceCode, 32)
        : null,
    scanCountry:
      typeof location?.countryCode === "string" && location.countryCode.length > 0
        ? truncate(location.countryCode, 8)
        : null,
  };
}

/**
 * Normalize a track result's FULL scan history into dispatchable
 * events, oldest-first (so the cached shipment status lands on the
 * newest scan after sequential dispatch). Scans without a parseable
 * date or without any usable event type are dropped.
 */
export function normalizeFedExScanEvents(input: {
  trackingNumber: string;
  trackResult: FedExTrackResult;
}): NormalizedFedExTrackingEvent[] {
  const out: NormalizedFedExTrackingEvent[] = [];
  for (const scan of input.trackResult.scanEvents ?? []) {
    const occurredAt = parseFedExDate(scan.date);
    if (occurredAt === null) {
      continue;
    }
    const statusCode = scan.derivedStatusCode ?? "";
    const eventType = scan.eventType ?? statusCode;
    if (eventType.length === 0) {
      continue;
    }
    out.push({
      externalEventId: truncate(
        `fedex:${input.trackingNumber}:scan:${eventType}:${occurredAt.toISOString()}`,
        128
      ),
      kind: normalizeFedExStatus(statusCode),
      carrierStatus: truncate(statusCode.length > 0 ? statusCode : eventType, 64),
      carrierStatusDetail:
        typeof scan.eventDescription === "string" && scan.eventDescription.length > 0
          ? truncate(scan.eventDescription, 128)
          : null,
      occurredAt,
      ...scanLocationFields(scan.scanLocation),
      rawPayload: scan as unknown as Record<string, unknown>,
    });
  }
  out.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  return out;
}

/**
 * Latest-status fallback when a track result has no usable scans —
 * preserves the pre-scan-ingestion event shape
 * (`fedex:{trackingNumber}:{statusCode}:{occurredAt}`), so
 * historical rows keep deduplicating.
 */
export function latestStatusFallbackEvent(input: {
  trackingNumber: string;
  trackResult: FedExTrackResult;
}): NormalizedFedExTrackingEvent | null {
  const statusCode = input.trackResult.latestStatusDetail?.code;
  if (typeof statusCode !== "string" || statusCode.length === 0) {
    return null;
  }
  const occurredAt = pickOccurredAt(input.trackResult) ?? new Date();
  return {
    externalEventId: truncate(
      `fedex:${input.trackingNumber}:${statusCode}:${occurredAt.toISOString()}`,
      128
    ),
    kind: normalizeFedExStatus(statusCode),
    carrierStatus: truncate(statusCode, 64),
    carrierStatusDetail:
      typeof input.trackResult.latestStatusDetail?.statusByLocale === "string"
        ? truncate(input.trackResult.latestStatusDetail.statusByLocale, 128)
        : null,
    occurredAt,
    ...scanLocationFields(input.trackResult.latestStatusDetail?.scanLocation),
    rawPayload: input.trackResult as unknown as Record<string, unknown>,
  };
}

/**
 * Full normalization for one track result: all scans oldest-first,
 * or the latest-status fallback when no scans are usable.
 */
export function normalizeFedExTrackResult(input: {
  trackingNumber: string;
  trackResult: FedExTrackResult;
}): NormalizedFedExTrackingEvent[] {
  const events = normalizeFedExScanEvents(input);
  if (events.length > 0) {
    return events;
  }
  const fallback = latestStatusFallbackEvent(input);
  return fallback === null ? [] : [fallback];
}
