// Shipping cost summary — postage spend by carrier + service level
// for shipments created within a date range.
//
// What operators use this for:
//
//   - "What did we spend on FedEx Overnight last month?"
//   - "Is average label cost drifting up on any lane?"
//   - "How much of our spend has no recorded cost?" (manual BYO
//     shipments + rows from before cost persistence — visible as
//     `unknownCostCount`, never silently folded into totals)
//
// Source of truth is `shipment.postageRateCents` — the carrier's
// price at purchase time, persisted by `PurchaseShipmentLabel`.
// This is the CARRIER cost side; what the clinic is billed lives in
// the billing domain (shipping-fee invoice lines) and reconciling
// the two is a billing report's job.
//
// PHI invariant: aggregates over non-PHI columns only (`carrier`,
// `serviceLevel`, `status`, `postageRateCents`, `createdAt`).

import { ShipmentCarrier } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface ShippingCostSummaryRow {
  readonly carrier: ShipmentCarrier;
  readonly serviceLevel: string;
  /** Shipments with a recorded postage cost. */
  readonly shipmentCount: number;
  /** Shipments with NULL cost (manual / pre-persistence rows). */
  readonly unknownCostCount: number;
  readonly totalPostageCents: number;
  readonly avgPostageCents: number;
  readonly minPostageCents: number;
  readonly maxPostageCents: number;
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

export type ShippingCostSummaryParams = z.infer<typeof paramsSchema>;

export const shippingCostSummaryReport: ReportDefinition<
  typeof paramsSchema,
  ShippingCostSummaryRow
> = {
  id: "shipping-cost-summary",
  version: 1,
  title: "Shipping cost summary",
  description:
    "Postage spend by carrier + service level for shipments created within a date range: total / average / min / max label cost, with unknown-cost shipments counted separately.",
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

  async run(ctx, params): Promise<ReportResult<ShippingCostSummaryRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };
    const baseWhere = {
      organizationId: ctx.organizationId,
      createdAt: { gte: window.from, lte: window.to },
      ...(params.carriers !== undefined && params.carriers.length > 0
        ? { carrier: { in: params.carriers } }
        : {}),
      // Clinic scope via the order relation (shipments carry no
      // clinicId column).
      ...(ctx.clinicId !== undefined ? { order: { clinicId: ctx.clinicId } } : {}),
    };

    // Two groupBys: costed rows (sum/avg/min/max) and NULL-cost rows
    // (count only). Splitting keeps NULL from skewing averages —
    // Prisma's _avg ignores NULLs but a combined _count would not.
    const costed = await ctx.client.shipment.groupBy({
      by: ["carrier", "serviceLevel"],
      where: { ...baseWhere, postageRateCents: { not: null } },
      _count: { _all: true },
      _sum: { postageRateCents: true },
      _avg: { postageRateCents: true },
      _min: { postageRateCents: true },
      _max: { postageRateCents: true },
    });

    const unknown = await ctx.client.shipment.groupBy({
      by: ["carrier", "serviceLevel"],
      where: { ...baseWhere, postageRateCents: null },
      _count: { _all: true },
    });

    const unknownByKey = new Map<string, number>(
      unknown.map((g) => [`${g.carrier}\u0000${g.serviceLevel}`, g._count._all])
    );

    const rows: ShippingCostSummaryRow[] = costed.map((g) => {
      const key = `${g.carrier}\u0000${g.serviceLevel}`;
      const unknownCostCount = unknownByKey.get(key) ?? 0;
      unknownByKey.delete(key);
      return Object.freeze({
        carrier: g.carrier,
        serviceLevel: g.serviceLevel,
        shipmentCount: g._count._all,
        unknownCostCount,
        totalPostageCents: g._sum.postageRateCents ?? 0,
        avgPostageCents: Math.round(g._avg.postageRateCents ?? 0),
        minPostageCents: g._min.postageRateCents ?? 0,
        maxPostageCents: g._max.postageRateCents ?? 0,
      });
    });

    // Groups that ONLY have unknown-cost shipments still deserve a
    // row — otherwise manual lanes vanish from the report entirely.
    for (const [key, count] of unknownByKey) {
      const [carrier, serviceLevel] = key.split("\u0000") as [ShipmentCarrier, string];
      rows.push(
        Object.freeze({
          carrier,
          serviceLevel,
          shipmentCount: 0,
          unknownCostCount: count,
          totalPostageCents: 0,
          avgPostageCents: 0,
          minPostageCents: 0,
          maxPostageCents: 0,
        })
      );
    }

    // Stable lexicographic ordering for deterministic CSV output.
    rows.sort((a, b) => {
      const c = a.carrier.localeCompare(b.carrier);
      if (c !== 0) return c;
      return a.serviceLevel.localeCompare(b.serviceLevel);
    });

    const totalPostageCents = rows.reduce((sum, r) => sum + r.totalPostageCents, 0);
    const costedCount = rows.reduce((sum, r) => sum + r.shipmentCount, 0);
    const unknownCostCount = rows.reduce((sum, r) => sum + r.unknownCostCount, 0);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalPostageCents,
        costedCount,
        unknownCostCount,
        totalShipmentCount: costedCount + unknownCostCount,
        avgPostageCents: costedCount === 0 ? 0 : Math.round(totalPostageCents / costedCount),
        distinctGroups: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
