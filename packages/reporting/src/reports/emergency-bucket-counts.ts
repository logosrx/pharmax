// Emergency bucket counts — what is sitting in an emergency bucket
// RIGHT NOW, by bucket and by the workflow stage each order was
// escalated out of.
//
// Serves the product requirement (rules: "emergency bucket counts",
// and the SLA rule's "orders over SLA … move or appear in an
// emergency bucket").
//
// Why this closes a loop
// ----------------------
// The worker's SLA breach evaluator dispatches
// `EscalateOrderForSlaBreach`, which moves breached orders into the
// org's EMERGENCY bucket; shipping's `EscalateOrderToEmergencyBucket`
// feeds the same bucket for carrier exceptions. Both write audit +
// outbox rows, and until now nothing counted the RESULT. The
// escalator could be firing hundreds of times a day and the only
// evidence would be the audit log. This is the meter on its output.
//
// Point-in-time, not windowed
// ---------------------------
// The question is "what is in the bucket now", so the report takes
// no parameters and applies no date filter — `shipments-in-flight`
// takes the same stance for undelivered packages. An order that
// entered and was dispositioned last Tuesday is not in the bucket
// and must not be counted; that is the escalation HISTORY, which
// lives in `audit_log` and belongs to a different report. The result
// window is the as-of instant on both edges, so the `report_run`
// ledger records exactly when the snapshot was taken.
//
// Why `Bucket.kind` and not the `EMERGENCY` code
// ----------------------------------------------
// `ProvisionDefaultBuckets` creates one bucket with code
// `EMERGENCY`, but `kind` is the column that carries the meaning and
// an org may add its own escalation buckets. Counting by kind means
// a custom emergency bucket is included the day it is created rather
// than the day someone remembers to update this report.
//
// `currentStatus` is on every row because the bucket move does NOT
// change workflow state — an escalated order keeps the status it
// breached in. So the status column says which stage is producing
// escalations, which is the actionable half: ten orders escalated
// out of FILL_IN_PROGRESS is a fill-capacity problem, ten out of
// PV1_IN_PROGRESS is a pharmacist-coverage problem.
//
// What is deliberately NOT reported
// ---------------------------------
// A "past SLA deadline" count. Orders reach this bucket BY breaching,
// so the column would sit near 100% and tell an operator nothing,
// while reading as meaningful for the shipping-escalated minority
// that arrives without a breach. `oldestAgeHours` carries the real
// signal instead: a bucket whose oldest order arrived this morning is
// a spike, one whose oldest order is four days old is a backlog
// nobody is working.
//
// PHI invariant: queries `currentBucketId`, `currentStatus`,
// `clinicId`, and `receivedAt` on the order, plus bucket code / name.
// No patient linkage is read or emitted, and no order ids are
// surfaced — this is a counts report, and a per-order emergency board
// belongs on the queue page where an operator can act on a row.

import { BucketKind, OrderStatus } from "@pharmax/database";
import { z } from "zod";

import type { ReportDefinition, ReportResult } from "../types.js";

export interface EmergencyBucketCountsRow {
  readonly bucketCode: string;
  readonly bucketName: string;
  /** The stage the order was escalated out of; the bucket move keeps it. */
  readonly currentStatus: OrderStatus;
  readonly orderCount: number;
  /** Intake time of the oldest order in this grouping. */
  readonly oldestReceivedAt: string | null;
  /** Hours since that intake; 0 when the grouping is empty. */
  readonly oldestAgeHours: number;
  /** Share of everything currently in an emergency bucket, in basis points. */
  readonly shareOfEmergencyBps: number;
}

/**
 * Statuses that mean the order has left the workflow. Excluded from
 * the "open orders" denominator so the rate measures emergency
 * pressure against LIVE work rather than against every order the org
 * has ever taken.
 */
const TERMINAL_STATUSES = [OrderStatus.SHIPPED, OrderStatus.CANCELLED] as const;

// Point-in-time: no window, no filters, nothing to tune.
const paramsSchema = z.object({}).strict();

export type EmergencyBucketCountsParams = z.infer<typeof paramsSchema>;

function rateBps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000);
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export const emergencyBucketCountsReport: ReportDefinition<
  typeof paramsSchema,
  EmergencyBucketCountsRow
> = {
  id: "emergency-bucket-counts",
  version: 1,
  title: "Emergency bucket counts",
  description:
    "Orders sitting in an emergency bucket right now, grouped by bucket and by the workflow stage they were escalated out of, with the age of the oldest order and emergency load as a share of open orders. Point-in-time: no date range.",
  parametersSchema: paramsSchema,
  parameterFields: [],

  async run(ctx): Promise<ReportResult<EmergencyBucketCountsRow>> {
    const now = ctx.asOf ?? new Date();

    // Buckets are matched on kind at ORG scope even for a
    // clinic-scoped operator: the default emergency bucket is
    // provisioned per site with a null `clinicId`, so narrowing the
    // BUCKET by clinic would return nothing and report a reassuring
    // zero. The clinic narrow belongs on the orders, which carry a
    // non-null `clinicId`.
    const emergencyBuckets = await ctx.client.bucket.findMany({
      where: { organizationId: ctx.organizationId, kind: BucketKind.EMERGENCY },
      select: { id: true, code: true, name: true },
    });

    const bucketsById = new Map(emergencyBuckets.map((b) => [b.id, b]));
    const bucketIds = emergencyBuckets.map((b) => b.id);
    const clinicScope = ctx.clinicId !== undefined ? { clinicId: ctx.clinicId } : {};

    const [groups, openOrderCount] = await Promise.all([
      // An org with no emergency bucket yields an empty `in` list and
      // therefore no groups — the same zero an unprovisioned org
      // deserves, without a special case that could drift.
      ctx.client.order.groupBy({
        by: ["currentBucketId", "currentStatus"],
        where: {
          organizationId: ctx.organizationId,
          currentBucketId: { in: bucketIds },
          ...clinicScope,
        },
        _count: { _all: true },
        _min: { receivedAt: true },
      }),
      ctx.client.order.count({
        where: {
          organizationId: ctx.organizationId,
          currentStatus: { notIn: [...TERMINAL_STATUSES] },
          ...clinicScope,
        },
      }),
    ]);

    const totalInEmergency = groups.reduce((n, g) => n + g._count._all, 0);

    const rows: EmergencyBucketCountsRow[] = [];
    for (const g of groups) {
      const bucket = bucketsById.get(g.currentBucketId);
      // The groupBy is constrained to exactly these bucket ids, so a
      // miss cannot happen. Skipping beats inventing a bucket name on
      // a row an operator would then go looking for.
      if (bucket === undefined) continue;
      const oldest = g._min.receivedAt;
      rows.push(
        Object.freeze({
          bucketCode: bucket.code,
          bucketName: bucket.name,
          currentStatus: g.currentStatus,
          orderCount: g._count._all,
          oldestReceivedAt: oldest?.toISOString() ?? null,
          oldestAgeHours:
            oldest === null || oldest === undefined
              ? 0
              : roundTenth((now.getTime() - oldest.getTime()) / 3_600_000),
          shareOfEmergencyBps: rateBps(g._count._all, totalInEmergency),
        })
      );
    }

    // Biggest pile first; bucket then stage as tiebreaks so equal
    // counts always serialize in the same order.
    rows.sort((a, b) => {
      if (b.orderCount !== a.orderCount) return b.orderCount - a.orderCount;
      if (a.bucketCode !== b.bucketCode) return a.bucketCode.localeCompare(b.bucketCode);
      return a.currentStatus.localeCompare(b.currentStatus);
    });

    // Rate numerator excludes terminal strays so both sides of the
    // ratio describe live work. A SHIPPED or CANCELLED order left
    // parked in an emergency bucket is still worth SEEING (it is
    // queue clutter someone has to disposition), so it stays in the
    // rows and in `totalInEmergency` — it just does not get to make
    // the pressure ratio look worse than the floor feels.
    const terminal: ReadonlyArray<OrderStatus> = TERMINAL_STATUSES;
    const openInEmergency = rows.reduce(
      (n, r) => (terminal.includes(r.currentStatus) ? n : n + r.orderCount),
      0
    );
    const distinctBuckets = new Set(rows.map((r) => r.bucketCode)).size;

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalInEmergency,
        openInEmergency,
        openOrderCount,
        emergencyShareOfOpenOrdersBps: rateBps(openInEmergency, openOrderCount),
        distinctBuckets,
        distinctGroups: rows.length,
      }),
      // Point-in-time: both edges are the snapshot instant.
      window: { from: now, to: now },
      generatedAt: now,
    });
  },
};
