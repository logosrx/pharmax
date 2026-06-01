// User productivity by stage — per-user average + total active
// work time per workflow stage, for ACTIVE intervals that
// completed within a date range.
//
// Directly serves the product requirement (see
// .cursor/rules/03-sla-performance.mdc): "average typing time by
// user", "average PV1 time by pharmacist", "average fill time by
// tech", "average final verification time by pharmacist",
// "throughput by user".
//
// Only the *_ACTIVE interval kinds carry an `actorUserId` (a user
// owned the work); the WAIT_BEFORE_* kinds are queue waits with
// no actor and are excluded. We window on `endedAt` (completed
// work in the period) so an open/in-progress interval doesn't
// skew the average with a partial duration.
//
// Aggregation runs in TypeScript (not Prisma `groupBy`) because
// the metric is an average of a COMPUTED duration
// (`endedAt - startedAt`), which `groupBy` cannot express — same
// findMany + post-process shape as the SLA breach report. Bounded
// by intervals-per-org-per-window; acceptable for an operator
// report and moves to a reporting replica in Phase 6.
//
// PHI invariant: stage intervals + the actor's display name are
// operator metadata (pharmacist/tech identity + timing), not
// patient data. No PHI columns queried.

import { OrderStageIntervalKind } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface UserProductivityByStageRow {
  readonly actorUserId: string;
  readonly actorUserName: string;
  readonly kind: OrderStageIntervalKind;
  readonly completedCount: number;
  readonly avgActiveSeconds: number;
  readonly totalActiveSeconds: number;
}

// The interval kinds that represent a user actively working
// (each carries an `actorUserId`). WAIT_BEFORE_* kinds are queue
// waits with no actor and are intentionally excluded.
const ACTIVE_KINDS = [
  OrderStageIntervalKind.TYPING_ACTIVE,
  OrderStageIntervalKind.PV1_ACTIVE,
  OrderStageIntervalKind.FILL_ACTIVE,
  OrderStageIntervalKind.FINAL_VERIFICATION_ACTIVE,
  OrderStageIntervalKind.SHIPPING_ACTIVE,
] as const;

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /** Restrict to specific ACTIVE stages; omit for all five. A
     *  WAIT_BEFORE_* kind here matches nothing (no actor). */
    kinds: z.array(z.enum(ACTIVE_KINDS)).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type UserProductivityByStageParams = z.infer<typeof paramsSchema>;

export const userProductivityByStageReport: ReportDefinition<
  typeof paramsSchema,
  UserProductivityByStageRow
> = {
  id: "user-productivity-by-stage",
  version: 1,
  title: "User productivity by stage",
  description:
    "Per-user completed count + average and total active work time (seconds) per workflow stage, for ACTIVE intervals that ended within a date range. Excludes queue-wait time.",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields(),
    {
      kind: "multi-enum",
      key: "kinds",
      label: "Stages",
      required: false,
      help: "Restrict to these active stages; leave empty for all.",
      options: ACTIVE_KINDS.map((k) => ({ value: k, label: k })),
    },
  ],

  async run(ctx, params): Promise<ReportResult<UserProductivityByStageRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    const kindsFilter =
      params.kinds !== undefined && params.kinds.length > 0 ? params.kinds : ACTIVE_KINDS;

    // The index `(organizationId, siteId, kind, startedAt)` does
    // not cover the `endedAt` window directly; `(organizationId,
    // orderId, endedAt)` is closer. For an operator report we
    // accept a windowed scan within the org. `endedAt: { gte, lte }`
    // implicitly excludes open intervals (null endedAt).
    const intervals = await ctx.client.orderStageInterval.findMany({
      where: {
        organizationId: ctx.organizationId,
        kind: { in: [...kindsFilter] },
        endedAt: { gte: window.from, lte: window.to },
        actorUserId: { not: null },
      },
      select: {
        actorUserId: true,
        kind: true,
        startedAt: true,
        endedAt: true,
        actorUser: { select: { displayName: true } },
      },
    });

    // Group by (actorUserId, kind) → count + summed duration.
    interface Acc {
      actorUserId: string;
      actorUserName: string;
      kind: OrderStageIntervalKind;
      count: number;
      totalMs: number;
    }
    const groups = new Map<string, Acc>();

    for (const iv of intervals) {
      // `actorUserId: { not: null }` guarantees a value, but the
      // select types it nullable — guard for the type-checker.
      if (iv.actorUserId === null || iv.endedAt === null) continue;
      const durationMs = iv.endedAt.getTime() - iv.startedAt.getTime();
      // Defensive: skip negative durations (clock skew / bad data)
      // so they don't drag an average negative.
      if (durationMs < 0) continue;
      const key = `${iv.actorUserId}|${iv.kind}`;
      const current = groups.get(key) ?? {
        actorUserId: iv.actorUserId,
        actorUserName: iv.actorUser?.displayName ?? "(unknown)",
        kind: iv.kind,
        count: 0,
        totalMs: 0,
      };
      current.count += 1;
      current.totalMs += durationMs;
      groups.set(key, current);
    }

    const rows: UserProductivityByStageRow[] = [...groups.values()]
      .map((g) =>
        Object.freeze({
          actorUserId: g.actorUserId,
          actorUserName: g.actorUserName,
          kind: g.kind,
          completedCount: g.count,
          avgActiveSeconds: Math.round(g.totalMs / g.count / 1000),
          totalActiveSeconds: Math.round(g.totalMs / 1000),
        })
      )
      // Deterministic CSV: user name then stage (enum order).
      .sort((a, b) => {
        if (a.actorUserName !== b.actorUserName) {
          return a.actorUserName < b.actorUserName ? -1 : 1;
        }
        const kinds: ReadonlyArray<OrderStageIntervalKind> = ACTIVE_KINDS;
        return kinds.indexOf(a.kind) - kinds.indexOf(b.kind);
      });

    const totalIntervals = rows.reduce((n, r) => n + r.completedCount, 0);
    const distinctUsers = new Set(rows.map((r) => r.actorUserId)).size;

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalIntervals,
        distinctUsers,
        distinctGroups: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
