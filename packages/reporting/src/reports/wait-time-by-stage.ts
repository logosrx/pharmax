// Wait time by stage — how long orders SIT between stages, per
// queue-wait interval, over a date range.
//
// Serves the product requirement (rules: "wait time by stage", and
// the SLA rule's five required WAIT_BEFORE_* interval concepts).
//
// Why this report did not already exist, and why it matters
// ---------------------------------------------------------
// The wait intervals have been recorded since the interval recorder
// shipped, but nothing reported on them:
//
//   - `sla-breach-report` surfaces intervals ALREADY over threshold.
//     That is the exception list, not the distribution — by the time
//     a row appears there, the order is late.
//   - `user-productivity-by-stage` deliberately EXCLUDES the wait
//     kinds, because a queue wait has no `actorUserId`. It measures
//     how fast people work.
//
// So the system could say an order breached, and how fast a tech
// works, but not where orders actually sit. That is the queue
// question: whether to move a tech to fill or to PV1 is answered by
// wait time, not by active time. A stage can have the fastest
// workers in the building and still be the bottleneck if orders
// queue for an hour before anyone picks them up.
//
// Percentiles, not just an average
// --------------------------------
// An average wait is precisely the statistic that hides a queue
// problem. A stage where most orders move in minutes but one in ten
// sits for hours has a healthy-looking mean, and every SLA breach
// comes out of that tail. So each stage reports p50 / p95 / max
// alongside the mean, and a count of waits that exceeded the stage's
// own SLA threshold.
//
// Thresholds come from `@pharmax/sla`, which owns them — the same
// map that sums into the end-to-end budget driving `slaDeadlineAt`.
// Comparing against a locally-declared copy would let this report
// disagree with the live escalator about what "late" means.
//
// Closed intervals only
// ---------------------
// Windowed on `endedAt`, which excludes open intervals (null
// `endedAt`). A wait still in progress has no final duration, and
// counting its partial elapsed time would drag every average toward
// zero — the newest, shortest waits would be over-represented
// exactly when a queue is backing up. Live queue pressure is
// already surfaced by the SLA badges on each queue page and by the
// emergency bucket; this report is the trend instrument.
//
// PHI invariant: stage intervals are workflow timing metadata. The
// columns read (`kind`, `startedAt`, `endedAt`) contain no patient
// data, and unlike the productivity report this one needs no actor
// join — a queue wait has no actor.

import { OrderStageIntervalKind } from "@pharmax/database";
import { DEFAULT_STAGE_SLA_THRESHOLDS_MS } from "@pharmax/sla";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

/**
 * The five queue-wait interval kinds. These carry no `actorUserId`:
 * nobody is working, the order is waiting to be picked up.
 */
const WAIT_KINDS = [
  OrderStageIntervalKind.WAIT_BEFORE_TYPING,
  OrderStageIntervalKind.WAIT_BEFORE_PV1,
  OrderStageIntervalKind.WAIT_BEFORE_FILL,
  OrderStageIntervalKind.WAIT_BEFORE_FINAL_VERIFICATION,
  OrderStageIntervalKind.WAIT_BEFORE_SHIPPING,
] as const;

export interface WaitTimeByStageRow {
  readonly kind: OrderStageIntervalKind;
  readonly completedCount: number;
  readonly avgWaitSeconds: number;
  readonly p50WaitSeconds: number;
  readonly p95WaitSeconds: number;
  readonly maxWaitSeconds: number;
  readonly totalWaitSeconds: number;
  /** The stage's SLA threshold, from `@pharmax/sla`. */
  readonly thresholdSeconds: number;
  readonly overThresholdCount: number;
  readonly overThresholdRateBps: number;
}

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /** Restrict to specific wait stages; omit for all five. */
    kinds: z.array(z.enum(WAIT_KINDS)).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type WaitTimeByStageParams = z.infer<typeof paramsSchema>;

function rateBps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000);
}

/**
 * Nearest-rank percentile over an ASCENDING-sorted array — the value
 * at `ceil(p × n)`, no interpolation.
 *
 * Stated explicitly because percentile conventions disagree and the
 * choice is visible in small samples: with 10 waits, p95 here is the
 * slowest of the ten rather than a value interpolated between the
 * 9th and 10th. For an operator report, "the 95th-percentile wait
 * was an actual observed wait" is the more defensible reading.
 */
function percentile(sortedAsc: ReadonlyArray<number>, p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(p * sortedAsc.length) - 1;
  const index = Math.min(Math.max(rank, 0), sortedAsc.length - 1);
  return sortedAsc[index]!;
}

export const waitTimeByStageReport: ReportDefinition<typeof paramsSchema, WaitTimeByStageRow> = {
  id: "wait-time-by-stage",
  version: 1,
  title: "Wait time by stage",
  description:
    "How long orders sit in each queue before work starts — mean, median, p95, and max wait per stage for waits that ended in the date range, with each stage's SLA threshold and the share of waits that exceeded it. Answers where orders queue, which is what active-work reports cannot show.",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields(),
    {
      kind: "multi-enum",
      key: "kinds",
      label: "Wait stages",
      required: false,
      help: "Restrict to these queue-wait stages; leave empty for all five.",
      options: WAIT_KINDS.map((k) => ({ value: k, label: k })),
    },
  ],

  async run(ctx, params): Promise<ReportResult<WaitTimeByStageRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    const kindsFilter =
      params.kinds !== undefined && params.kinds.length > 0 ? params.kinds : WAIT_KINDS;

    // findMany + in-process aggregation rather than `groupBy`: the
    // metric is a distribution over a COMPUTED duration
    // (`endedAt - startedAt`), which `groupBy` cannot express, and
    // percentiles need the individual values anyway. Same shape as
    // the SLA breach and productivity reports. Bounded by
    // wait-intervals-per-org-per-window; moves to the reporting
    // replica in Phase 6.
    //
    // `endedAt: { gte, lte }` implicitly excludes open intervals.
    const intervals = await ctx.client.orderStageInterval.findMany({
      where: {
        organizationId: ctx.organizationId,
        kind: { in: [...kindsFilter] },
        endedAt: { gte: window.from, lte: window.to },
        // Clinic scope via the order relation (intervals carry no
        // clinicId column). Required so a clinic-scoped operator
        // does not see another clinic's queue behaviour.
        ...(ctx.clinicId !== undefined ? { order: { clinicId: ctx.clinicId } } : {}),
      },
      select: { kind: true, startedAt: true, endedAt: true },
    });

    const durationsByKind = new Map<OrderStageIntervalKind, number[]>();
    for (const interval of intervals) {
      if (interval.endedAt === null) continue;
      const durationMs = interval.endedAt.getTime() - interval.startedAt.getTime();
      // Defensive: a negative duration means clock skew or bad data.
      // Dropping it is better than letting it pull an average down,
      // and it cannot be a real wait.
      if (durationMs < 0) continue;
      const bucket = durationsByKind.get(interval.kind);
      if (bucket === undefined) durationsByKind.set(interval.kind, [durationMs]);
      else bucket.push(durationMs);
    }

    const rows: WaitTimeByStageRow[] = [...durationsByKind.entries()]
      .map(([kind, durationsMs]) => {
        const sorted = [...durationsMs].sort((a, b) => a - b);
        const count = sorted.length;
        const totalMs = sorted.reduce((sum, ms) => sum + ms, 0);
        const thresholdMs = DEFAULT_STAGE_SLA_THRESHOLDS_MS[kind] ?? 0;
        // Strictly greater than: a wait exactly AT the threshold is
        // within SLA, matching `classifySlaStatus`'s inclusive
        // boundary handling.
        const overThreshold =
          thresholdMs === 0 ? 0 : sorted.filter((ms) => ms > thresholdMs).length;

        return Object.freeze({
          kind,
          completedCount: count,
          avgWaitSeconds: Math.round(totalMs / count / 1000),
          p50WaitSeconds: Math.round(percentile(sorted, 0.5) / 1000),
          p95WaitSeconds: Math.round(percentile(sorted, 0.95) / 1000),
          maxWaitSeconds: Math.round(sorted[count - 1]! / 1000),
          totalWaitSeconds: Math.round(totalMs / 1000),
          thresholdSeconds: Math.round(thresholdMs / 1000),
          overThresholdCount: overThreshold,
          overThresholdRateBps: rateBps(overThreshold, count),
        });
      })
      // Workflow order, so the CSV reads like the pipeline rather
      // than being sorted by whichever stage happened to be worst.
      .sort((a, b) => {
        const kinds: ReadonlyArray<OrderStageIntervalKind> = WAIT_KINDS;
        return kinds.indexOf(a.kind) - kinds.indexOf(b.kind);
      });

    const totalWaits = rows.reduce((n, r) => n + r.completedCount, 0);
    const totalOverThreshold = rows.reduce((n, r) => n + r.overThresholdCount, 0);
    const totalWaitSeconds = rows.reduce((n, r) => n + r.totalWaitSeconds, 0);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalWaits,
        totalWaitSeconds,
        overallOverThresholdCount: totalOverThreshold,
        overallOverThresholdRateBps: rateBps(totalOverThreshold, totalWaits),
        distinctStages: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
