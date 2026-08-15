// Throughput by clinic — how many orders each clinic COMPLETED in a
// window, and how long each clinic's orders took end to end.
//
// Serves the product requirement (rules: "throughput by
// user/team/clinic/product").
//
// Why this is not `order-volume-by-stage` with a status filter
// ------------------------------------------------------------
// The obvious objection is that `order-volume-by-stage` already
// groups orders by clinic and can be filtered to SHIPPED. It windows
// on `receivedAt`, and that single difference makes it answer a
// different question:
//
//   - `order-volume-by-stage` filtered to SHIPPED = "of the orders we
//     TOOK IN during the window, how many have since shipped." An
//     intake cohort. Orders received in April and shipped in May land
//     in April's number, and May's number is silent about them.
//
//   - This report = "how many orders LEFT THE BUILDING during the
//     window." That is throughput, and it is the number that gets
//     compared against staffing, against last week, and against a
//     clinic's own forecast.
//
// The two diverge exactly when it matters — during a backlog, when
// intake and completion are furthest apart, and the intake-cohort
// number reads high while nothing is actually shipping.
//
// Turnaround, which nothing else reports
// --------------------------------------
// Volume alone would still be thin, so each clinic also gets its
// end-to-end turnaround: intake to shipment, the whole pipeline.
// `wait-time-by-stage` and `user-productivity-by-stage` measure one
// stage each and cannot be summed into this (an order's stages
// overlap with other orders' stages, and holds and reopens sit
// between them); `sla-breach-report` lists only the exceptions; and
// `shipment-transit-time` starts where this ends, at the carrier
// handoff. So "clinic A is 40% of our volume and takes twice as long"
// is a sentence no existing report can produce.
//
// Percentiles for the same reason `wait-time-by-stage` carries them:
// a mean turnaround hides the tail that produces every escalation.
// Nearest-rank, no interpolation — with ten orders, p95 is the
// slowest of the ten rather than an interpolated value, so every
// number printed is a turnaround some order actually experienced.
//
// Keyed on `shippedAt`, not `currentStatus`
// -----------------------------------------
// `shippedAt` is stamped once, by `ConfirmShipment`, and never
// cleared. Selecting on it rather than on `currentStatus = SHIPPED`
// means an order that shipped and was later moved into some other
// state still counts as work completed in the window — throughput is
// what left the building, not what the row says today.
//
// An order that shipped with a `shippedAt` before its `receivedAt`
// (clock skew between app instances) still counts toward throughput
// — it shipped — but its impossible duration is dropped from the
// turnaround sample rather than dragging every average toward zero.
// `turnaroundSampleCount` makes the basis of the statistics explicit
// whenever the two differ.
//
// PHI invariant: queries `clinicId`, `receivedAt`, and `shippedAt`
// only. No patient linkage, and no clinic name join — a clinic name
// is a display concern the console resolves, and the sibling
// `billing-summary-by-clinic` reports the id for the same reason.

import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface ThroughputByClinicRow {
  readonly clinicId: string;
  /** Orders that shipped within the window. */
  readonly shippedCount: number;
  /** Share of the org's throughput in the window, in basis points. */
  readonly shareOfThroughputBps: number;
  /** Orders contributing to the turnaround statistics below. */
  readonly turnaroundSampleCount: number;
  readonly avgTurnaroundHours: number;
  readonly p50TurnaroundHours: number;
  readonly p95TurnaroundHours: number;
  readonly maxTurnaroundHours: number;
}

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type ThroughputByClinicParams = z.infer<typeof paramsSchema>;

function rateBps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000);
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Nearest-rank percentile over an ASCENDING-sorted array — the value
 * at `ceil(p × n)`, no interpolation. Same convention as
 * `wait-time-by-stage`, so the two reports' p95s mean the same thing.
 */
function percentile(sortedAsc: ReadonlyArray<number>, p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(p * sortedAsc.length) - 1;
  const index = Math.min(Math.max(rank, 0), sortedAsc.length - 1);
  return sortedAsc[index]!;
}

function hours(ms: number): number {
  return roundTenth(ms / 3_600_000);
}

export const throughputByClinicReport: ReportDefinition<
  typeof paramsSchema,
  ThroughputByClinicRow
> = {
  id: "throughput-by-clinic",
  version: 1,
  title: "Throughput by clinic",
  description:
    "Orders shipped per clinic within a date range, with each clinic's share of throughput and its end-to-end turnaround (mean, median, p95, max) from intake to shipment. Windowed on shipment, so it measures what left the building rather than what was taken in.",
  parametersSchema: paramsSchema,
  parameterFields: [...dateRangeFields()],

  async run(ctx, params): Promise<ReportResult<ThroughputByClinicRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    // findMany + in-process aggregation rather than `groupBy`: the
    // turnaround is a COMPUTED duration (`shippedAt - receivedAt`),
    // which `groupBy` cannot express, and percentiles need the
    // individual values. Same shape as `wait-time-by-stage`. Bounded
    // by orders-shipped-per-org-per-window and moves to the reporting
    // replica in Phase 6.
    const orders = await ctx.client.order.findMany({
      where: {
        organizationId: ctx.organizationId,
        shippedAt: { gte: window.from, lte: window.to },
        ...(ctx.clinicId !== undefined ? { clinicId: ctx.clinicId } : {}),
      },
      select: { clinicId: true, receivedAt: true, shippedAt: true },
    });

    const byClinic = new Map<string, { shipped: number; turnaroundsMs: number[] }>();

    for (const order of orders) {
      // The `gte`/`lte` filter already excludes unshipped orders; this
      // narrows the nullable column and cannot drop a real row.
      if (order.shippedAt === null) continue;
      const accumulator = byClinic.get(order.clinicId) ?? { shipped: 0, turnaroundsMs: [] };
      accumulator.shipped += 1;
      const turnaroundMs = order.shippedAt.getTime() - order.receivedAt.getTime();
      if (turnaroundMs >= 0) accumulator.turnaroundsMs.push(turnaroundMs);
      byClinic.set(order.clinicId, accumulator);
    }

    const totalShipped = [...byClinic.values()].reduce((n, a) => n + a.shipped, 0);

    const rows: ThroughputByClinicRow[] = [...byClinic.entries()]
      .map(([clinicId, accumulator]) => {
        const sorted = [...accumulator.turnaroundsMs].sort((a, b) => a - b);
        const sampleCount = sorted.length;
        const totalMs = sorted.reduce((sum, ms) => sum + ms, 0);
        return Object.freeze({
          clinicId,
          shippedCount: accumulator.shipped,
          shareOfThroughputBps: rateBps(accumulator.shipped, totalShipped),
          turnaroundSampleCount: sampleCount,
          avgTurnaroundHours: sampleCount === 0 ? 0 : hours(totalMs / sampleCount),
          p50TurnaroundHours: hours(percentile(sorted, 0.5)),
          p95TurnaroundHours: hours(percentile(sorted, 0.95)),
          maxTurnaroundHours: sampleCount === 0 ? 0 : hours(sorted[sampleCount - 1]!),
        });
      })
      // Busiest clinic first; clinic id as the tiebreak so equal
      // volumes always serialize in the same order.
      .sort((a, b) =>
        b.shippedCount !== a.shippedCount
          ? b.shippedCount - a.shippedCount
          : a.clinicId.localeCompare(b.clinicId)
      );

    // Org-wide turnaround is recomputed over every order rather than
    // averaged across the rows: a mean of clinic means would weight a
    // clinic that shipped three orders the same as one that shipped
    // three hundred.
    const allTurnaroundsMs = [...byClinic.values()]
      .flatMap((a) => a.turnaroundsMs)
      .sort((a, b) => a - b);
    const overallTotalMs = allTurnaroundsMs.reduce((sum, ms) => sum + ms, 0);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalShipped,
        turnaroundSampleCount: allTurnaroundsMs.length,
        avgTurnaroundHours:
          allTurnaroundsMs.length === 0 ? 0 : hours(overallTotalMs / allTurnaroundsMs.length),
        p95TurnaroundHours: hours(percentile(allTurnaroundsMs, 0.95)),
        distinctClinics: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
