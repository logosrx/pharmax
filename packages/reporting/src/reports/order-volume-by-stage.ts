// Order volume by stage — counts of orders broken out by their
// `currentStatus` (i.e. which workflow stage they are currently
// in), filtered to orders that landed within a date range and
// optionally narrowed to a single clinic.
//
// What operators use this for:
//
//   - "How many orders are in the PV1 queue today?"
//   - "Is the FILL queue backing up compared to last week?"
//   - "What's the typing throughput per clinic this month?"
//
// Why `currentStatus` (vs. event history):
//
//   - O(1) lookup against a single column with a covering index.
//   - "Orders currently in stage X" is the operator's mental
//     model; event-history aggregation is the "throughput over
//     time" report (a future slice — `orderThroughputByStage`).
//
// PHI invariant: queries only non-PHI columns (`organizationId`,
// `clinicId`, `currentStatus`, `receivedAt`).

import { OrderStatus } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface OrderVolumeByStageRow {
  readonly clinicId: string;
  readonly currentStatus: OrderStatus;
  readonly orderCount: number;
}

const ORDER_STATUSES = [
  OrderStatus.RECEIVED,
  OrderStatus.TYPING_IN_PROGRESS,
  OrderStatus.TYPED_READY_FOR_PV1,
  OrderStatus.PV1_IN_PROGRESS,
  OrderStatus.PV1_APPROVED_READY_FOR_FILL,
  OrderStatus.FILL_IN_PROGRESS,
  OrderStatus.FILL_COMPLETED_READY_FOR_FINAL,
  OrderStatus.FINAL_VERIFICATION_IN_PROGRESS,
  OrderStatus.FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP,
  OrderStatus.READY_TO_SHIP,
  OrderStatus.SHIPPED,
  OrderStatus.TYPING_PENDING_MISSING_INFO,
  OrderStatus.PV1_REJECTED,
  OrderStatus.FINAL_VERIFICATION_REJECTED,
  OrderStatus.ON_HOLD,
  OrderStatus.CANCELLED,
] as const;

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /** Restrict to statuses in this set; omit for all statuses. */
    statuses: z.array(z.enum(ORDER_STATUSES)).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type OrderVolumeByStageParams = z.infer<typeof paramsSchema>;

export const orderVolumeByStageReport: ReportDefinition<
  typeof paramsSchema,
  OrderVolumeByStageRow
> = {
  id: "order-volume-by-stage",
  version: 1,
  title: "Order volume by stage",
  description:
    "Counts of orders by current workflow status (per clinic), for orders received within a date range.",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields(),
    {
      kind: "multi-enum",
      key: "statuses",
      label: "Statuses",
      required: false,
      help: "Restrict to these workflow statuses; leave empty for all.",
      options: ORDER_STATUSES.map((s) => ({ value: s, label: s })),
    },
  ],

  async run(ctx, params): Promise<ReportResult<OrderVolumeByStageRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    // `groupBy` collapses the order table to one row per
    // (clinicId, currentStatus). The index
    // `(organizationId, currentBucketId, currentStatus, priority, …)`
    // is the closest available; for this report we accept a
    // sequential scan within (organizationId, clinicId) — the
    // shape of an operator-facing dashboard does not justify a
    // dedicated index until volumes warrant it. Worst-case bound
    // is ~10K rows per org for the largest tenants; well within
    // OLTP budget.
    const groups = await ctx.client.order.groupBy({
      by: ["clinicId", "currentStatus"],
      where: {
        organizationId: ctx.organizationId,
        ...(ctx.clinicId !== undefined ? { clinicId: ctx.clinicId } : {}),
        receivedAt: { gte: window.from, lte: window.to },
        ...(params.statuses !== undefined && params.statuses.length > 0
          ? { currentStatus: { in: params.statuses } }
          : {}),
      },
      _count: { _all: true },
    });

    const rows: OrderVolumeByStageRow[] = groups.map((g) =>
      Object.freeze({
        clinicId: g.clinicId,
        currentStatus: g.currentStatus,
        orderCount: g._count._all,
      })
    );

    const totalCount = rows.reduce((sum, r) => sum + r.orderCount, 0);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({ totalCount, distinctGroups: rows.length }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
