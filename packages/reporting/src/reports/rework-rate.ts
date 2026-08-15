// Rework rate — how often finished work is thrown back, by reason
// and by how far back it goes, over a date range.
//
// Serves the product requirement (rules: "rework rates").
//
// What this answers that the rejection-rate report cannot
// -------------------------------------------------------
// `verification-rejection-rate` counts the DECISION: a pharmacist
// pressed reject at PV1 or FINAL. That is a quality signal, but it
// is not the cost. The cost is the loop the decision creates — the
// order goes back to a typist, gets re-typed, re-verified, and
// occupies two queues a second time. And rejection is only one way
// into that loop: `ReopenForCorrection` also fires for a supervisor
// pulling an order back, a prescription clarification, or a label
// redo, none of which produce a verification record at all. So the
// rejection rate can look flat while rework climbs.
//
// `OrderCorrectionReopen` is where the loop itself is recorded, and
// nothing reported on it before this.
//
// Why three dimensions per row
// ----------------------------
// The pair (reopenedFromStatus → reopenToStatus) IS the loop, and
// its span is the cost: reopening from FILL_IN_PROGRESS back to
// TYPING_IN_PROGRESS discards a fill and a PV1, while reopening from
// TYPED_READY_FOR_PV1 back to TYPING_IN_PROGRESS discards a few
// minutes of typing. The reason explains why. Collapsing to reason
// alone would rank a cheap loop above an expensive one whenever it
// happened more often.
//
// Events vs. orders, and which one the rate uses
// ---------------------------------------------
// An order can be reopened repeatedly, so the row counts are reopen
// EVENTS while `reworkRateBps` is built from DISTINCT orders. A
// single order sent back three times is one order that needed
// rework, not three; rating on events would let one pathological
// order inflate the rate past what the floor experienced.
// `repeatReopenCount` (events minus distinct orders) is the gap
// between the two, and a rising gap means the same orders are
// bouncing rather than more orders being touched once.
//
// The denominator, and its cohort caveat
// --------------------------------------
// Orders RECEIVED in the same window, matching the cancellation
// report. The two sides are different cohorts on purpose — a reopen
// in the window usually belongs to an order received in it, but not
// always, and an order received at the window's edge may be reopened
// after it. In steady state this is the operational rework rate;
// during a volume spike it lags by roughly one order lifetime.
// Windowed on `reopenedAt`, the axis the question is asked on, which
// is also the indexed one (`(organizationId, reopenedAt)`).
//
// PHI invariant: `reasonText` is operator free-text — a correction
// note can quote a prescriber call or name a patient — so it is
// never selected and never reaches a row. Only the closed
// `ReopenReason` enum and the two workflow statuses do.
// `reopenedByUserId` is deliberately absent: "who reopens the most"
// is a productivity question, and the person who REOPENS an order is
// usually not the person whose work caused the loop.

import { ReopenReason } from "@pharmax/database";
import type { OrderStatus } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface ReworkRateRow {
  readonly reason: ReopenReason;
  /** The status the order was pulled out of. */
  readonly reopenedFromStatus: OrderStatus;
  /** The status it was sent back to — the span is the cost. */
  readonly reopenToStatus: OrderStatus;
  readonly reopenCount: number;
  /** Share of all reopens in the window, in basis points. */
  readonly shareOfReopensBps: number;
}

const REASONS = [
  ReopenReason.TYPING_CORRECTION,
  ReopenReason.PRESCRIPTION_CLARIFICATION,
  ReopenReason.PV1_REWORK,
  ReopenReason.FILL_REDO,
  ReopenReason.LABEL_REWORK,
  ReopenReason.SUPERVISOR_DIRECTED,
  ReopenReason.OTHER,
] as const;

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /** Restrict to specific reopen reasons; omit for all seven. */
    reasons: z.array(z.enum(REASONS)).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type ReworkRateParams = z.infer<typeof paramsSchema>;

function rateBps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000);
}

export const reworkRateReport: ReportDefinition<typeof paramsSchema, ReworkRateRow> = {
  id: "rework-rate",
  version: 1,
  title: "Rework rate",
  description:
    "Order reopens by reason and by the stages they moved between, within a date range, with the share of reopens per loop and a rework rate built from distinct orders against intake volume. Measures the loop a rejection causes, which the rejection-rate report does not.",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields(),
    {
      kind: "multi-enum",
      key: "reasons",
      label: "Reopen reasons",
      required: false,
      help: "Restrict to these reopen reasons; leave empty for all.",
      options: REASONS.map((r) => ({ value: r, label: r })),
    },
  ],

  async run(ctx, params): Promise<ReportResult<ReworkRateRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    // Reopens carry no `clinicId` column, so clinic scope goes
    // through the order relation; orders carry it directly. BOTH
    // sides of the rate must be narrowed, or one clinic's rework
    // would be divided by the whole org's intake.
    const reopenWhere = {
      organizationId: ctx.organizationId,
      reopenedAt: { gte: window.from, lte: window.to },
      ...(params.reasons !== undefined && params.reasons.length > 0
        ? { reason: { in: params.reasons } }
        : {}),
      ...(ctx.clinicId !== undefined ? { order: { clinicId: ctx.clinicId } } : {}),
    };

    const [groups, orderGroups, ordersReceived] = await Promise.all([
      ctx.client.orderCorrectionReopen.groupBy({
        by: ["reason", "reopenedFromStatus", "reopenToStatus"],
        where: reopenWhere,
        _count: { _all: true },
      }),
      // Distinct reopened orders. `groupBy(["orderId"])` rather than
      // a count because Prisma has no distinct-count aggregate; the
      // result is bounded by reopened-orders-per-window, which is a
      // small fraction of order volume by construction (an org where
      // it is not has a much larger problem than this query).
      ctx.client.orderCorrectionReopen.groupBy({
        by: ["orderId"],
        where: reopenWhere,
      }),
      ctx.client.order.count({
        where: {
          organizationId: ctx.organizationId,
          receivedAt: { gte: window.from, lte: window.to },
          ...(ctx.clinicId !== undefined ? { clinicId: ctx.clinicId } : {}),
        },
      }),
    ]);

    const totalReopens = groups.reduce((n, g) => n + g._count._all, 0);
    const ordersReopened = orderGroups.length;

    const rows: ReworkRateRow[] = groups
      .map((g) =>
        Object.freeze({
          reason: g.reason,
          reopenedFromStatus: g.reopenedFromStatus,
          reopenToStatus: g.reopenToStatus,
          reopenCount: g._count._all,
          shareOfReopensBps: rateBps(g._count._all, totalReopens),
        })
      )
      // Most frequent loop first, then reason, then the two stages,
      // so equal counts always serialize in the same order.
      .sort((a, b) => {
        if (b.reopenCount !== a.reopenCount) return b.reopenCount - a.reopenCount;
        if (a.reason !== b.reason) return a.reason.localeCompare(b.reason);
        if (a.reopenedFromStatus !== b.reopenedFromStatus) {
          return a.reopenedFromStatus.localeCompare(b.reopenedFromStatus);
        }
        return a.reopenToStatus.localeCompare(b.reopenToStatus);
      });

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalReopens,
        ordersReopened,
        // Events beyond the first per order — the same orders
        // bouncing rather than more orders being touched once.
        repeatReopenCount: totalReopens - ordersReopened,
        ordersReceivedInWindow: ordersReceived,
        reworkRateBps: rateBps(ordersReopened, ordersReceived),
        distinctGroups: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
