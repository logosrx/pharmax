// Shipment transit time — delivery performance by carrier +
// service level for shipments DELIVERED within a date range.
//
// What operators use this for:
//
//   - "How long does FedEx 2Day actually take door-to-door?"
//   - "Is Ground transit time drifting up this month?"
//   - "What share of deliveries beat the carrier's own estimate?"
//
// Transit time = carrier handoff (`confirmedAt`, stamped by
// `ConfirmShipment`) → the DELIVERED tracking event's `occurredAt`
// (cached as `lastTrackingEventAt` once the shipment reaches
// DELIVERED). Both ends are carrier-truth timestamps, not poll
// times, so the numbers stay accurate regardless of poll cadence.
//
// On-time = delivered at or before the carrier's final
// `estimatedDeliveryAt`. Shipments without an estimate are counted
// separately, never silently folded into on-time or late.
//
// PHI invariant: queries only non-PHI columns (`carrier`,
// `serviceLevel`, `confirmedAt`, `lastTrackingEventAt`,
// `estimatedDeliveryAt`). No recipient address, no patient linkage.

import { ShipmentCarrier, ShipmentStatus } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface ShipmentTransitTimeRow {
  readonly carrier: ShipmentCarrier;
  readonly serviceLevel: string;
  readonly shipmentCount: number;
  /** Mean transit hours, rounded to 1 decimal. */
  readonly avgTransitHours: number;
  /** Median transit hours, rounded to 1 decimal. */
  readonly p50TransitHours: number;
  /** 95th-percentile transit hours, rounded to 1 decimal. */
  readonly p95TransitHours: number;
  /** Delivered at or before the carrier's estimate. */
  readonly onTimeCount: number;
  /** Delivered after the carrier's estimate. */
  readonly lateCount: number;
  /** Delivered but no carrier estimate was ever recorded. */
  readonly noEstimateCount: number;
}

const CARRIERS = [
  ShipmentCarrier.USPS,
  ShipmentCarrier.UPS,
  ShipmentCarrier.FEDEX,
  ShipmentCarrier.DHL,
  ShipmentCarrier.OTHER,
] as const;

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /** Restrict to specific carriers; omit for all. */
    carriers: z.array(z.enum(CARRIERS)).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type ShipmentTransitTimeParams = z.infer<typeof paramsSchema>;

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Percentile over a pre-sorted ascending array using the
 * nearest-rank method (deterministic, no interpolation surprises
 * in CSV output).
 */
function percentileSorted(sortedAsc: ReadonlyArray<number>, p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(Math.max(rank, 1), sortedAsc.length) - 1;
  return sortedAsc[idx] ?? 0;
}

interface GroupAccumulator {
  readonly carrier: ShipmentCarrier;
  readonly serviceLevel: string;
  readonly transitHours: number[];
  onTimeCount: number;
  lateCount: number;
  noEstimateCount: number;
}

export const shipmentTransitTimeReport: ReportDefinition<
  typeof paramsSchema,
  ShipmentTransitTimeRow
> = {
  id: "shipment-transit-time",
  version: 1,
  title: "Shipment transit time",
  description:
    "Door-to-door transit time (carrier handoff → delivered scan) by carrier + service level for shipments delivered within a date range, with on-time-vs-carrier-estimate counts.",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields(),
    {
      kind: "multi-enum",
      key: "carriers",
      label: "Carriers",
      required: false,
      help: "Restrict to these carriers; leave empty for all.",
      options: CARRIERS.map((c) => ({ value: c, label: c })),
    },
  ],

  async run(ctx, params): Promise<ReportResult<ShipmentTransitTimeRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    // Delivered-in-window shipments with a real carrier handoff.
    // Transit source, in preference order:
    //   1. Persisted scan endpoints — `pickedUpAt` → `deliveredAt`
    //      (carrier-truth pickup-to-delivery, maintained by
    //      RecordShipmentTrackingEvent since the transit-timestamps
    //      migration).
    //   2. Fallback for older rows — `confirmedAt` (our handoff
    //      stamp) → `lastTrackingEventAt` (delivered scan while
    //      DELIVERED is the newest event).
    // Bounded by the window; the report reads timestamps + two
    // dimensions per row.
    const shipments = await ctx.client.shipment.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: ShipmentStatus.DELIVERED,
        confirmedAt: { not: null },
        lastTrackingEventAt: { gte: window.from, lte: window.to },
        ...(params.carriers !== undefined && params.carriers.length > 0
          ? { carrier: { in: params.carriers } }
          : {}),
        // Clinic scope via the order relation (shipments carry no
        // clinicId column).
        ...(ctx.clinicId !== undefined ? { order: { clinicId: ctx.clinicId } } : {}),
      },
      select: {
        carrier: true,
        serviceLevel: true,
        confirmedAt: true,
        lastTrackingEventAt: true,
        estimatedDeliveryAt: true,
        pickedUpAt: true,
        deliveredAt: true,
        transitSeconds: true,
      },
    });

    const groups = new Map<string, GroupAccumulator>();
    for (const s of shipments) {
      // Prefer the persisted pickup→delivery pair; fall back to
      // handoff→delivered-scan for rows predating the columns.
      let transitMs: number;
      if (s.transitSeconds !== null) {
        transitMs = s.transitSeconds * 1000;
      } else {
        // Both guaranteed non-null by the where clause; narrow for TS.
        if (s.confirmedAt === null || s.lastTrackingEventAt === null) continue;
        transitMs = s.lastTrackingEventAt.getTime() - s.confirmedAt.getTime();
      }
      if (transitMs < 0) continue; // clock skew guard — never report negative transit

      const key = `${s.carrier}\u0000${s.serviceLevel}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          carrier: s.carrier,
          serviceLevel: s.serviceLevel,
          transitHours: [],
          onTimeCount: 0,
          lateCount: 0,
          noEstimateCount: 0,
        };
        groups.set(key, group);
      }
      group.transitHours.push(transitMs / 3_600_000);
      // On-time comparison uses the physical delivery moment when
      // persisted; `lastTrackingEventAt` otherwise.
      const deliveredMoment = s.deliveredAt ?? s.lastTrackingEventAt;
      if (s.estimatedDeliveryAt === null) {
        group.noEstimateCount += 1;
      } else if (
        deliveredMoment !== null &&
        deliveredMoment.getTime() <= s.estimatedDeliveryAt.getTime()
      ) {
        group.onTimeCount += 1;
      } else {
        group.lateCount += 1;
      }
    }

    const rows: ShipmentTransitTimeRow[] = [...groups.values()]
      .map((g) => {
        const sorted = [...g.transitHours].sort((a, b) => a - b);
        const sum = sorted.reduce((acc, h) => acc + h, 0);
        return Object.freeze({
          carrier: g.carrier,
          serviceLevel: g.serviceLevel,
          shipmentCount: sorted.length,
          avgTransitHours: roundTenth(sorted.length === 0 ? 0 : sum / sorted.length),
          p50TransitHours: roundTenth(percentileSorted(sorted, 50)),
          p95TransitHours: roundTenth(percentileSorted(sorted, 95)),
          onTimeCount: g.onTimeCount,
          lateCount: g.lateCount,
          noEstimateCount: g.noEstimateCount,
        });
      })
      // Stable lexicographic ordering for deterministic CSV output.
      .sort((a, b) => {
        const c = a.carrier.localeCompare(b.carrier);
        if (c !== 0) return c;
        return a.serviceLevel.localeCompare(b.serviceLevel);
      });

    const totalCount = rows.reduce((sum, r) => sum + r.shipmentCount, 0);
    const onTimeCount = rows.reduce((sum, r) => sum + r.onTimeCount, 0);
    const lateCount = rows.reduce((sum, r) => sum + r.lateCount, 0);
    const noEstimateCount = rows.reduce((sum, r) => sum + r.noEstimateCount, 0);
    // On-time rate in basis points over shipments that HAD an
    // estimate (on-time + late); no-estimate rows are excluded from
    // the denominator rather than diluting the rate.
    const withEstimate = onTimeCount + lateCount;
    const onTimeRateBps =
      withEstimate === 0 ? 0 : Math.round((onTimeCount / withEstimate) * 10_000);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalCount,
        onTimeCount,
        lateCount,
        noEstimateCount,
        onTimeRateBps,
        distinctGroups: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
