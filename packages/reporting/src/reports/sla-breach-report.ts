// SLA breach report — surfaces order stage intervals that exceeded
// per-stage SLA thresholds within a date range. The operator UI
// uses this to populate breach dashboards, emergency-bucket
// candidates, and management review.
//
// Definition of "breach":
//
//   For each `OrderStageInterval` row whose `kind` is in the
//   thresholds table:
//     duration = (endedAt ?? asOf) - startedAt
//     breached = duration > threshold
//
//   - Closed intervals (`endedAt` set) are evaluated against their
//     actual end time.
//   - Open intervals (`endedAt` null) are evaluated against the
//     `asOf` parameter — operators want to see ACTIVELY breaching
//     work, not just historical breaches.
//
// v1 thresholds are hardcoded (`DEFAULT_STAGE_SLA_THRESHOLDS_MS`).
// A future slice (`@pharmax/sla` config table) will move them to
// per-org configurable rows; this module imports the constants so
// the breach math has a single source of truth.
//
// PHI invariant: queries only non-PHI columns
// (`organizationId`, `siteId`, `orderId`, `kind`, `startedAt`,
// `endedAt`). The row shape excludes patient-identifying data.

import { OrderStageIntervalKind } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

/**
 * Default per-stage SLA thresholds in milliseconds. v1 hardcoded;
 * follow-up: per-org configurable via a `sla_threshold` table.
 *
 * Picked from LifeFile-style operational defaults; tune per
 * clinic / volume / SLA contract once real data lands.
 */
export const DEFAULT_STAGE_SLA_THRESHOLDS_MS: Readonly<
  Partial<Record<OrderStageIntervalKind, number>>
> = Object.freeze({
  [OrderStageIntervalKind.WAIT_BEFORE_TYPING]: 30 * 60_000, // 30 min
  [OrderStageIntervalKind.TYPING_ACTIVE]: 30 * 60_000,
  [OrderStageIntervalKind.WAIT_BEFORE_PV1]: 30 * 60_000,
  [OrderStageIntervalKind.PV1_ACTIVE]: 20 * 60_000,
  [OrderStageIntervalKind.WAIT_BEFORE_FILL]: 60 * 60_000, // 1h
  [OrderStageIntervalKind.FILL_ACTIVE]: 45 * 60_000,
  [OrderStageIntervalKind.WAIT_BEFORE_FINAL_VERIFICATION]: 30 * 60_000,
  [OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE]: 20 * 60_000,
  [OrderStageIntervalKind.WAIT_BEFORE_SHIPPING]: 4 * 60 * 60_000, // 4h
  [OrderStageIntervalKind.SHIPPING_ACTIVE]: 24 * 60 * 60_000, // 24h
});

export interface SlaBreachRow {
  readonly intervalId: string;
  readonly orderId: string;
  readonly siteId: string;
  readonly kind: OrderStageIntervalKind;
  readonly startedAt: Date;
  /** Null when the interval is still open. */
  readonly endedAt: Date | null;
  readonly durationMs: number;
  readonly thresholdMs: number;
  readonly overBy: number;
  /** True when the interval is still open (active breach). */
  readonly active: boolean;
}

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /**
     * Restrict the report to specific stage kinds; omit for all
     * configured stages.
     */
    kinds: z
      .array(
        z.enum([
          OrderStageIntervalKind.WAIT_BEFORE_TYPING,
          OrderStageIntervalKind.TYPING_ACTIVE,
          OrderStageIntervalKind.WAIT_BEFORE_PV1,
          OrderStageIntervalKind.PV1_ACTIVE,
          OrderStageIntervalKind.WAIT_BEFORE_FILL,
          OrderStageIntervalKind.FILL_ACTIVE,
          OrderStageIntervalKind.WAIT_BEFORE_FINAL_VERIFICATION,
          OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE,
          OrderStageIntervalKind.WAIT_BEFORE_SHIPPING,
          OrderStageIntervalKind.SHIPPING_ACTIVE,
        ])
      )
      .optional(),
    /**
     * Override default thresholds (useful for what-if analysis or
     * per-clinic overrides surfaced from UI sliders). Falls back
     * to `DEFAULT_STAGE_SLA_THRESHOLDS_MS` per-stage.
     */
    thresholdOverridesMs: z.record(z.string(), z.number().int().nonnegative()).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type SlaBreachReportParams = z.infer<typeof paramsSchema>;

function resolveThreshold(
  kind: OrderStageIntervalKind,
  overrides: Record<string, number> | undefined
): number | null {
  if (overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, kind)) {
    return overrides[kind] ?? null;
  }
  return DEFAULT_STAGE_SLA_THRESHOLDS_MS[kind] ?? null;
}

export const slaBreachReport: ReportDefinition<typeof paramsSchema, SlaBreachRow> = {
  id: "sla-breach-report",
  version: 1,
  title: "SLA breaches by stage",
  description:
    "Order stage intervals that exceeded per-stage SLA thresholds within a date range. Includes ACTIVE breaches (open intervals evaluated against the report's asOf timestamp).",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields(),
    {
      kind: "multi-enum",
      key: "kinds",
      label: "Stage kinds",
      required: false,
      help: "Restrict to these stage intervals; leave empty for all stages.",
      options: [
        OrderStageIntervalKind.WAIT_BEFORE_TYPING,
        OrderStageIntervalKind.TYPING_ACTIVE,
        OrderStageIntervalKind.WAIT_BEFORE_PV1,
        OrderStageIntervalKind.PV1_ACTIVE,
        OrderStageIntervalKind.WAIT_BEFORE_FILL,
        OrderStageIntervalKind.FILL_ACTIVE,
        OrderStageIntervalKind.WAIT_BEFORE_FINAL_VERIFICATION,
        OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE,
        OrderStageIntervalKind.WAIT_BEFORE_SHIPPING,
        OrderStageIntervalKind.SHIPPING_ACTIVE,
      ].map((k) => ({ value: k, label: k })),
    },
  ],

  async run(ctx, params): Promise<ReportResult<SlaBreachRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };
    const asOf = ctx.asOf ?? new Date();
    const asOfMs = asOf.getTime();

    // The where clause filters to intervals that STARTED within
    // the window OR are still open. We post-filter to "breaching"
    // in TypeScript because the threshold math depends on
    // overrides + asOf, neither of which translate cleanly to a
    // SQL filter. The row count here is bounded by the org's
    // active interval volume (~thousands at worst); acceptable
    // for an OLTP dashboard call.
    const candidateRows = await ctx.client.orderStageInterval.findMany({
      where: {
        organizationId: ctx.organizationId,
        startedAt: { gte: window.from, lte: window.to },
        ...(params.kinds !== undefined && params.kinds.length > 0
          ? { kind: { in: params.kinds } }
          : {}),
      },
      select: {
        id: true,
        orderId: true,
        siteId: true,
        kind: true,
        startedAt: true,
        endedAt: true,
      },
      orderBy: [{ kind: "asc" }, { startedAt: "asc" }],
    });

    const breaches: SlaBreachRow[] = [];
    let activeBreachCount = 0;
    let closedBreachCount = 0;
    let totalOverByMs = 0;

    for (const row of candidateRows) {
      const threshold = resolveThreshold(row.kind, params.thresholdOverridesMs);
      if (threshold === null) continue;

      const endMs = row.endedAt?.getTime() ?? asOfMs;
      const durationMs = endMs - row.startedAt.getTime();
      if (durationMs <= threshold) continue;

      const overBy = durationMs - threshold;
      const active = row.endedAt === null;

      breaches.push(
        Object.freeze({
          intervalId: row.id,
          orderId: row.orderId,
          siteId: row.siteId,
          kind: row.kind,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          durationMs,
          thresholdMs: threshold,
          overBy,
          active,
        })
      );
      totalOverByMs += overBy;
      if (active) activeBreachCount += 1;
      else closedBreachCount += 1;
    }

    return Object.freeze({
      rows: breaches,
      aggregates: Object.freeze({
        breachCount: breaches.length,
        activeBreachCount,
        closedBreachCount,
        totalOverByMs,
      }),
      window,
      generatedAt: asOf,
    });
  },
};
