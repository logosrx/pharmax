// Shipment exception breakdown — counts of shipments grouped by
// carrier + status, for shipments created within a date range,
// with aggregates that surface the exception rate.
//
// What operators use this for:
//
//   - "How many FedEx shipments bounced to RETURN_TO_SENDER this
//     month?"
//   - "Is one carrier's exception rate spiking vs. the others?"
//   - "What share of last week's shipments are stuck in EXCEPTION
//     / FAILED_DELIVERY?"
//
// Pairs with the SHIPPING queue + the emergency bucket: this is
// the after-the-fact analytics view of the same carrier states
// the live pollers stamp on each Shipment row.
//
// PHI invariant: queries only non-PHI columns (`organizationId`,
// `siteId`, `carrier`, `status`, `createdAt`). No recipient
// address, no patient linkage.

import { ShipmentCarrier, ShipmentStatus } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface ShipmentExceptionBreakdownRow {
  readonly carrier: ShipmentCarrier;
  readonly status: ShipmentStatus;
  readonly shipmentCount: number;
}

const CARRIERS = [
  ShipmentCarrier.USPS,
  ShipmentCarrier.UPS,
  ShipmentCarrier.FEDEX,
  ShipmentCarrier.DHL,
  ShipmentCarrier.OTHER,
] as const;

// The statuses that count as "exceptions" for the headline rate.
const EXCEPTION_STATUSES: ReadonlySet<ShipmentStatus> = new Set([
  ShipmentStatus.EXCEPTION,
  ShipmentStatus.RETURN_TO_SENDER,
  ShipmentStatus.FAILED_DELIVERY,
]);

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

export type ShipmentExceptionBreakdownParams = z.infer<typeof paramsSchema>;

export const shipmentExceptionBreakdownReport: ReportDefinition<
  typeof paramsSchema,
  ShipmentExceptionBreakdownRow
> = {
  id: "shipment-exception-breakdown",
  version: 1,
  title: "Shipment exception breakdown",
  description:
    "Counts of shipments by carrier + delivery status for shipments created within a date range, with an exception-rate aggregate (EXCEPTION / RETURN_TO_SENDER / FAILED_DELIVERY).",
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

  async run(ctx, params): Promise<ReportResult<ShipmentExceptionBreakdownRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    // groupBy collapses the shipment table to one row per
    // (carrier, status). The covering index
    // `(organizationId, siteId, status, createdAt)` partially
    // serves this; the carrier dimension is a sequential scan
    // within the org's shipments for the window — acceptable for
    // an operator dashboard at current volumes.
    const groups = await ctx.client.shipment.groupBy({
      by: ["carrier", "status"],
      where: {
        organizationId: ctx.organizationId,
        createdAt: { gte: window.from, lte: window.to },
        ...(params.carriers !== undefined && params.carriers.length > 0
          ? { carrier: { in: params.carriers } }
          : {}),
      },
      _count: { _all: true },
    });

    const rows: ShipmentExceptionBreakdownRow[] = groups
      .map((g) =>
        Object.freeze({
          carrier: g.carrier,
          status: g.status,
          shipmentCount: g._count._all,
        })
      )
      // Stable ordering for deterministic CSV output: carrier then
      // status, both lexicographic. Lexicographic (not enum-index)
      // ordering is deliberate — it's what an operator scanning the
      // CSV expects, and it does not silently reshuffle every report
      // if the Prisma enum's member order is ever changed.
      .sort((a, b) => {
        const c = a.carrier.localeCompare(b.carrier);
        if (c !== 0) return c;
        return a.status.localeCompare(b.status);
      });

    const totalCount = rows.reduce((sum, r) => sum + r.shipmentCount, 0);
    const exceptionCount = rows.reduce(
      (sum, r) => (EXCEPTION_STATUSES.has(r.status) ? sum + r.shipmentCount : sum),
      0
    );
    const deliveredCount = rows.reduce(
      (sum, r) => (r.status === ShipmentStatus.DELIVERED ? sum + r.shipmentCount : sum),
      0
    );
    // Exception rate as basis points (integer) so the aggregates
    // map stays `Record<string, number>` without float surprises
    // in the CSV. e.g. 250 = 2.50%.
    const exceptionRateBps =
      totalCount === 0 ? 0 : Math.round((exceptionCount / totalCount) * 10_000);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalCount,
        exceptionCount,
        deliveredCount,
        distinctGroups: rows.length,
        exceptionRateBps,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
