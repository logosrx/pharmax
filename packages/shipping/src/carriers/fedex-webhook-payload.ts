// FedEx Advanced Integrated Visibility webhook payload parsing +
// PHI-safe storage projection.
//
// AIV notifications carry the Track API's trackResult shape — the
// same `scanEvents[]` / `latestStatusDetail` / `dateAndTimes`
// structure the polling channel consumes — wrapped in one of two
// documented envelopes:
//
//   { "trackResults": [ { trackingNumber, scanEvents, ... } ] }
//   { "output": { "completeTrackResults": [ { trackingNumber,
//       trackResults: [ ... ] } ] } }
//
// We accept both and normalize to a flat list of
// `(trackingNumber, trackResult)` pairs. Parsing is deliberately
// TOLERANT (Zod `.loose()` object shapes): FedEx adds fields over
// time, and a webhook receiver that 400s on unknown fields converts
// every payload evolution into a retry storm.
//
// PHI: account-number AIV subscriptions include shipper/recipient
// name, address, and contact info in the payload. The inbox row is
// RLS-exempt, so `projectFedExWebhookForStorage` strips the body
// down to the replay-only subset — tracking number, scan events
// (which carry only carrier-facility scan locations), latest status,
// and date/times — BEFORE anything is persisted.

import { z } from "zod";

import type { FedExTrackResult } from "./fedex-client.js";

export class FedExWebhookPayloadError extends Error {
  constructor(reason: string) {
    super(`FedEx webhook payload parse failed: ${reason}`);
    this.name = "FedExWebhookPayloadError";
  }
}

const scanLocationSchema = z
  .object({
    city: z.string().optional(),
    stateOrProvinceCode: z.string().optional(),
    countryCode: z.string().optional(),
  })
  .loose();

const scanEventSchema = z
  .object({
    date: z.string().optional(),
    eventType: z.string().optional(),
    eventDescription: z.string().optional(),
    derivedStatusCode: z.string().optional(),
    derivedStatus: z.string().optional(),
    scanLocation: scanLocationSchema.optional(),
  })
  .loose();

const trackResultSchema = z
  .object({
    trackingNumber: z.string().optional(),
    latestStatusDetail: z
      .object({
        code: z.string().optional(),
        statusByLocale: z.string().optional(),
        description: z.string().optional(),
        derivedCode: z.string().optional(),
        scanLocation: scanLocationSchema.optional(),
      })
      .loose()
      .optional(),
    dateAndTimes: z
      .array(z.object({ type: z.string().optional(), dateTime: z.string().optional() }).loose())
      .optional(),
    scanEvents: z.array(scanEventSchema).optional(),
    error: z
      .object({ code: z.string().optional(), message: z.string().optional() })
      .loose()
      .optional(),
  })
  .loose();

const flatEnvelopeSchema = z.object({ trackResults: z.array(trackResultSchema).min(1) }).loose();

const nestedEnvelopeSchema = z
  .object({
    output: z
      .object({
        completeTrackResults: z
          .array(
            z
              .object({
                trackingNumber: z.string().optional(),
                trackResults: z.array(trackResultSchema).optional(),
              })
              .loose()
          )
          .min(1),
      })
      .loose(),
  })
  .loose();

/** One tracking number's track result extracted from a delivery. */
export interface FedExWebhookTrackEntry {
  readonly trackingNumber: string;
  readonly trackResult: FedExTrackResult;
}

/**
 * Parse an AIV webhook body (already JSON.parsed) into a flat list
 * of `(trackingNumber, trackResult)` entries. Entries without a
 * resolvable tracking number are dropped; an empty result after
 * dropping throws `FedExWebhookPayloadError`.
 */
export function parseFedExWebhookPayload(rawJson: unknown): ReadonlyArray<FedExWebhookTrackEntry> {
  const entries: FedExWebhookTrackEntry[] = [];

  const flat = flatEnvelopeSchema.safeParse(rawJson);
  if (flat.success) {
    for (const result of flat.data.trackResults) {
      const trackingNumber = result.trackingNumber;
      if (typeof trackingNumber === "string" && trackingNumber.length > 0) {
        entries.push({ trackingNumber, trackResult: result as FedExTrackResult });
      }
    }
  } else {
    const nested = nestedEnvelopeSchema.safeParse(rawJson);
    if (!nested.success) {
      throw new FedExWebhookPayloadError(
        "Body matches neither { trackResults: [...] } nor { output: { completeTrackResults: [...] } }."
      );
    }
    for (const complete of nested.data.output.completeTrackResults) {
      for (const result of complete.trackResults ?? []) {
        const trackingNumber = result.trackingNumber ?? complete.trackingNumber;
        if (typeof trackingNumber === "string" && trackingNumber.length > 0) {
          entries.push({ trackingNumber, trackResult: result as FedExTrackResult });
        }
      }
    }
  }

  if (entries.length === 0) {
    throw new FedExWebhookPayloadError("No track entry carries a tracking number.");
  }
  return entries;
}

/**
 * PHI-minimized projection persisted to the RLS-exempt inbox row.
 * Exactly the fields the worker replays — nothing from the inbound
 * body that could carry shipper/recipient PHI survives.
 */
export interface FedExWebhookStoredPayload {
  readonly entries: ReadonlyArray<{
    readonly trackingNumber: string;
    readonly trackResult: {
      readonly latestStatusDetail?: {
        readonly code?: string;
        readonly statusByLocale?: string;
        readonly scanLocation?: {
          readonly city?: string;
          readonly stateOrProvinceCode?: string;
          readonly countryCode?: string;
        };
      };
      readonly dateAndTimes?: ReadonlyArray<{
        readonly type?: string;
        readonly dateTime?: string;
      }>;
      readonly scanEvents?: ReadonlyArray<{
        readonly date?: string;
        readonly eventType?: string;
        readonly eventDescription?: string;
        readonly derivedStatusCode?: string;
        readonly scanLocation?: {
          readonly city?: string;
          readonly stateOrProvinceCode?: string;
          readonly countryCode?: string;
        };
      }>;
    };
  }>;
}

function projectScanLocation(
  location: { city?: string; stateOrProvinceCode?: string; countryCode?: string } | undefined
): { city?: string; stateOrProvinceCode?: string; countryCode?: string } | undefined {
  if (location === undefined) return undefined;
  return {
    ...(location.city !== undefined ? { city: location.city } : {}),
    ...(location.stateOrProvinceCode !== undefined
      ? { stateOrProvinceCode: location.stateOrProvinceCode }
      : {}),
    ...(location.countryCode !== undefined ? { countryCode: location.countryCode } : {}),
  };
}

export function projectFedExWebhookForStorage(
  entries: ReadonlyArray<FedExWebhookTrackEntry>
): FedExWebhookStoredPayload {
  return {
    entries: entries.map((entry) => {
      const latestLocation = projectScanLocation(
        entry.trackResult.latestStatusDetail?.scanLocation
      );
      return {
        trackingNumber: entry.trackingNumber,
        trackResult: {
          ...(entry.trackResult.latestStatusDetail !== undefined
            ? {
                latestStatusDetail: {
                  ...(entry.trackResult.latestStatusDetail.code !== undefined
                    ? { code: entry.trackResult.latestStatusDetail.code }
                    : {}),
                  ...(entry.trackResult.latestStatusDetail.statusByLocale !== undefined
                    ? { statusByLocale: entry.trackResult.latestStatusDetail.statusByLocale }
                    : {}),
                  ...(latestLocation !== undefined ? { scanLocation: latestLocation } : {}),
                },
              }
            : {}),
          ...(entry.trackResult.dateAndTimes !== undefined
            ? {
                dateAndTimes: entry.trackResult.dateAndTimes.map((d) => ({
                  ...(d.type !== undefined ? { type: d.type } : {}),
                  ...(d.dateTime !== undefined ? { dateTime: d.dateTime } : {}),
                })),
              }
            : {}),
          ...(entry.trackResult.scanEvents !== undefined
            ? {
                scanEvents: entry.trackResult.scanEvents.map((scan) => {
                  const scanLocation = projectScanLocation(scan.scanLocation);
                  return {
                    ...(scan.date !== undefined ? { date: scan.date } : {}),
                    ...(scan.eventType !== undefined ? { eventType: scan.eventType } : {}),
                    ...(scan.eventDescription !== undefined
                      ? { eventDescription: scan.eventDescription }
                      : {}),
                    ...(scan.derivedStatusCode !== undefined
                      ? { derivedStatusCode: scan.derivedStatusCode }
                      : {}),
                    ...(scanLocation !== undefined ? { scanLocation } : {}),
                  };
                }),
              }
            : {}),
        },
      };
    }),
  };
}
