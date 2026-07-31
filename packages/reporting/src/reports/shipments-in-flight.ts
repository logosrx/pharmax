// Shipments in flight — one row per undelivered shipment with its
// last known carrier location, freshness, and estimate breach.
//
// This is the "where is every package right now" board:
//
//   - "Show me everything in the FedEx network and its last scan."
//   - "Which packages have gone dark (no scan in 24h+)?"
//   - "Which packages are already past the carrier's estimate?"
//
// Freshness is measured from the last CARRIER event (`occurredAt`
// of the newest tracking event), not from our poll time — a package
// we polled five minutes ago but that hasn't scanned since Tuesday
// is stale, and that distinction is the whole point.
//
// PHI invariant: rows carry tracking number (a carrier artifact,
// not PHI), scan location at carrier-facility city granularity,
// and shipment dimensions. No recipient address, no patient
// linkage.

import { ShipmentCarrier, ShipmentStatus } from "@pharmax/database";
import type { ShipmentTrackingEventKind } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface ShipmentInFlightRow {
  readonly carrier: ShipmentCarrier;
  readonly serviceLevel: string;
  readonly trackingNumber: string;
  readonly status: ShipmentStatus;
  readonly lastEventKind: ShipmentTrackingEventKind | null;
  readonly lastEventAt: string | null;
  readonly lastScanCity: string | null;
  readonly lastScanState: string | null;
  /** Hours since the last carrier event; -1 when no event yet. */
  readonly hoursSinceLastEvent: number;
  readonly estimatedDeliveryAt: string | null;
  /** Past the carrier's estimate and still not delivered. */
  readonly pastEstimate: boolean;
  /** No carrier event within the stale threshold. */
  readonly stale: boolean;
}

const CARRIERS = [
  ShipmentCarrier.USPS,
  ShipmentCarrier.UPS,
  ShipmentCarrier.FEDEX,
  ShipmentCarrier.DHL,
  ShipmentCarrier.OTHER,
] as const;

// Hard row cap — an operator board, not a bulk export. Stalest
// shipments sort first, so the cap trims the healthiest rows.
const MAX_ROWS = 5_000;

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /** Restrict to specific carriers; omit for all. */
    carriers: z.array(z.enum(CARRIERS)).optional(),
    /** Hours without a carrier event before a shipment counts as stale. */
    staleThresholdHours: z.number().int().positive().max(720).default(24),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type ShipmentsInFlightParams = z.infer<typeof paramsSchema>;

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export const shipmentsInFlightReport: ReportDefinition<typeof paramsSchema, ShipmentInFlightRow> = {
  id: "shipments-in-flight",
  version: 1,
  title: "Shipments in flight",
  description:
    "Every undelivered shipment created within the window, with its last known carrier scan location, hours since the last carrier event, and whether it is past the carrier's delivery estimate.",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields({ fromDefault: "now-30d" }),
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
      key: "staleThresholdHours",
      label: "Stale threshold (hours)",
      required: false,
      help: "Hours without a carrier event before a shipment counts as stale.",
      min: 1,
      max: 720,
      defaultValue: 24,
    },
  ],

  async run(ctx, params): Promise<ReportResult<ShipmentInFlightRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };
    const now = ctx.asOf ?? new Date();

    const shipments = await ctx.client.shipment.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { not: ShipmentStatus.DELIVERED },
        createdAt: { gte: window.from, lte: window.to },
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
        trackingNumber: true,
        status: true,
        estimatedDeliveryAt: true,
        lastTrackingEventAt: true,
        trackingEvents: {
          orderBy: { occurredAt: "desc" },
          take: 1,
          select: {
            kind: true,
            occurredAt: true,
            scanCity: true,
            scanStateOrProvince: true,
          },
        },
      },
      // Stalest first: shipments with NO event at all lead, then
      // oldest-last-event ascending. Matches the operator's triage
      // order and makes the row cap trim the healthy tail.
      orderBy: [{ lastTrackingEventAt: { sort: "asc", nulls: "first" } }],
      take: MAX_ROWS,
    });

    const staleThresholdMs = params.staleThresholdHours * 3_600_000;

    const rows: ShipmentInFlightRow[] = shipments.map((s) => {
      const latest = s.trackingEvents[0] ?? null;
      const lastEventAt = latest?.occurredAt ?? null;
      const hoursSinceLastEvent =
        lastEventAt === null ? -1 : roundTenth((now.getTime() - lastEventAt.getTime()) / 3_600_000);
      return Object.freeze({
        carrier: s.carrier,
        serviceLevel: s.serviceLevel,
        trackingNumber: s.trackingNumber,
        status: s.status,
        lastEventKind: latest?.kind ?? null,
        lastEventAt: lastEventAt?.toISOString() ?? null,
        lastScanCity: latest?.scanCity ?? null,
        lastScanState: latest?.scanStateOrProvince ?? null,
        hoursSinceLastEvent,
        estimatedDeliveryAt: s.estimatedDeliveryAt?.toISOString() ?? null,
        pastEstimate:
          s.estimatedDeliveryAt !== null && now.getTime() > s.estimatedDeliveryAt.getTime(),
        stale: lastEventAt === null || now.getTime() - lastEventAt.getTime() > staleThresholdMs,
      });
    });

    const staleCount = rows.reduce((sum, r) => (r.stale ? sum + 1 : sum), 0);
    const pastEstimateCount = rows.reduce((sum, r) => (r.pastEstimate ? sum + 1 : sum), 0);
    const exceptionCount = rows.reduce(
      (sum, r) =>
        r.status === ShipmentStatus.EXCEPTION ||
        r.status === ShipmentStatus.RETURN_TO_SENDER ||
        r.status === ShipmentStatus.FAILED_DELIVERY
          ? sum + 1
          : sum,
      0
    );
    const neverScannedCount = rows.reduce((sum, r) => (r.lastEventAt === null ? sum + 1 : sum), 0);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalInFlight: rows.length,
        staleCount,
        pastEstimateCount,
        exceptionCount,
        neverScannedCount,
      }),
      window,
      generatedAt: now,
    });
  },
};
