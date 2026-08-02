// Late deliveries — one row per shipment that missed the carrier's
// delivery estimate within a date range.
//
// Complements `shipment-transit-time` (aggregate on-time rate by
// carrier + service level): this is the per-shipment miss list an
// operator actually works from —
//
//   - "Which packages arrived late last week, and by how much?"
//   - "Which packages are STILL out there past their estimate?"
//   - "Is one service level producing most of the misses?"
//
// Two miss categories, distinguished by `outcome`:
//   - DELIVERED_LATE  — delivered after `estimatedDeliveryAt`
//                       (delivered-in-window filter).
//   - STILL_OUTSTANDING — not delivered, estimate already passed
//                       (created-in-window filter; the miss is
//                       ongoing so `hoursLate` grows until delivery).
//
// Shipments without a carrier estimate cannot "miss" it and are
// EXCLUDED — surfacing them is `shipments-in-flight`'s job (stale
// detection by last-scan age, no estimate required).
//
// PHI invariant: rows carry tracking number, carrier dimensions, and
// timestamps only. No recipient address, no patient linkage.

import { ShipmentCarrier, ShipmentStatus } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export type LateDeliveryOutcome = "DELIVERED_LATE" | "STILL_OUTSTANDING";

export interface LateDeliveryRow {
  readonly carrier: ShipmentCarrier;
  readonly serviceLevel: string;
  readonly trackingNumber: string;
  readonly status: ShipmentStatus;
  readonly outcome: LateDeliveryOutcome;
  readonly estimatedDeliveryAt: string;
  /** Delivered-scan time for DELIVERED_LATE; null while outstanding. */
  readonly deliveredAt: string | null;
  /** Hours past the estimate, rounded to 1 decimal. Grows until
   *  delivery for STILL_OUTSTANDING rows. */
  readonly hoursLate: number;
  /** Postage paid for the label, when known (integer USD cents). */
  readonly postageRateCents: number | null;
}

const CARRIERS = [
  ShipmentCarrier.USPS,
  ShipmentCarrier.UPS,
  ShipmentCarrier.FEDEX,
  ShipmentCarrier.DHL,
  ShipmentCarrier.OTHER,
] as const;

// Miss list, not a bulk export — worst offenders first, capped.
const MAX_ROWS = 5_000;

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /** Restrict to specific carriers; omit for all. */
    carriers: z.array(z.enum(CARRIERS)).optional(),
    /** Only count misses of at least this many hours (grace window). */
    minHoursLate: z.number().min(0).max(720).default(0),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type LateDeliveriesParams = z.infer<typeof paramsSchema>;

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export const lateDeliveriesReport: ReportDefinition<typeof paramsSchema, LateDeliveryRow> = {
  id: "late-deliveries",
  version: 1,
  title: "Late deliveries",
  description:
    "Every shipment that missed the carrier's delivery estimate — delivered late within the window, or still undelivered past its estimate — with hours late and postage paid.",
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
    {
      kind: "number",
      key: "minHoursLate",
      label: "Minimum hours late",
      required: false,
      help: "Grace window — only count misses of at least this many hours.",
      min: 0,
      max: 720,
      defaultValue: 0,
    },
  ],

  async run(ctx, params): Promise<ReportResult<LateDeliveryRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };
    const now = ctx.asOf ?? new Date();
    const carrierFilter =
      params.carriers !== undefined && params.carriers.length > 0
        ? { carrier: { in: params.carriers } }
        : {};
    const clinicFilter = ctx.clinicId !== undefined ? { order: { clinicId: ctx.clinicId } } : {};
    const select = {
      carrier: true,
      serviceLevel: true,
      trackingNumber: true,
      status: true,
      estimatedDeliveryAt: true,
      lastTrackingEventAt: true,
      postageRateCents: true,
    } as const;

    // Category 1 — delivered late: DELIVERED in-window, delivered
    // scan strictly after the estimate. The lateness comparison is
    // re-checked in JS below because SQL can only compare the two
    // columns via a raw filter; fetching delivered-in-window rows
    // with an estimate and filtering here keeps the query on the
    // tenancy-enforced client. Bounded by the window.
    const delivered = await ctx.client.shipment.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: ShipmentStatus.DELIVERED,
        estimatedDeliveryAt: { not: null },
        lastTrackingEventAt: { gte: window.from, lte: window.to },
        ...carrierFilter,
        ...clinicFilter,
      },
      select,
      take: MAX_ROWS,
    });

    // Category 2 — still outstanding: not delivered, estimate in the
    // past, created in-window.
    const outstanding = await ctx.client.shipment.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { not: ShipmentStatus.DELIVERED },
        estimatedDeliveryAt: { lt: now },
        createdAt: { gte: window.from, lte: window.to },
        ...carrierFilter,
        ...clinicFilter,
      },
      select,
      take: MAX_ROWS,
    });

    const minLateMs = params.minHoursLate * 3_600_000;
    const rows: LateDeliveryRow[] = [];

    for (const s of delivered) {
      if (s.estimatedDeliveryAt === null || s.lastTrackingEventAt === null) continue;
      const lateMs = s.lastTrackingEventAt.getTime() - s.estimatedDeliveryAt.getTime();
      if (lateMs <= 0 || lateMs < minLateMs) continue; // on time (or within grace)
      rows.push(
        Object.freeze({
          carrier: s.carrier,
          serviceLevel: s.serviceLevel,
          trackingNumber: s.trackingNumber,
          status: s.status,
          outcome: "DELIVERED_LATE" as const,
          estimatedDeliveryAt: s.estimatedDeliveryAt.toISOString(),
          deliveredAt: s.lastTrackingEventAt.toISOString(),
          hoursLate: roundTenth(lateMs / 3_600_000),
          postageRateCents: s.postageRateCents,
        })
      );
    }

    for (const s of outstanding) {
      if (s.estimatedDeliveryAt === null) continue;
      const lateMs = now.getTime() - s.estimatedDeliveryAt.getTime();
      if (lateMs < minLateMs) continue;
      rows.push(
        Object.freeze({
          carrier: s.carrier,
          serviceLevel: s.serviceLevel,
          trackingNumber: s.trackingNumber,
          status: s.status,
          outcome: "STILL_OUTSTANDING" as const,
          estimatedDeliveryAt: s.estimatedDeliveryAt.toISOString(),
          deliveredAt: null,
          hoursLate: roundTenth(lateMs / 3_600_000),
          postageRateCents: s.postageRateCents,
        })
      );
    }

    // Worst offenders first.
    rows.sort((a, b) => b.hoursLate - a.hoursLate);
    const capped = rows.slice(0, MAX_ROWS);

    const deliveredLateCount = capped.reduce(
      (sum, r) => (r.outcome === "DELIVERED_LATE" ? sum + 1 : sum),
      0
    );
    const stillOutstandingCount = capped.length - deliveredLateCount;
    const totalHoursLate = capped.reduce((sum, r) => sum + r.hoursLate, 0);
    const avgHoursLateTenths =
      capped.length === 0 ? 0 : Math.round((totalHoursLate / capped.length) * 10);

    return Object.freeze({
      rows: capped,
      aggregates: Object.freeze({
        totalCount: capped.length,
        deliveredLateCount,
        stillOutstandingCount,
        // Tenths of an hour (integer) — aggregates are number-typed
        // and integer-friendly for CSV.
        avgHoursLateTenths,
      }),
      window,
      generatedAt: now,
    });
  },
};
