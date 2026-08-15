// Cancellation reasons by exit stage — cancellation counts per
// disposition reason, broken out by the workflow status the order
// was cancelled FROM, over a date range.
//
// Serves the product requirement (rules: "cancellation reasons").
//
// Why the reason × exit-stage pivot rather than a flat reason count
// -----------------------------------------------------------------
// A flat count says INSURANCE_DENIAL is the top reason. It does not
// say how much work was already spent when we found out, and that is
// the part a supervisor can act on. The same reason cancelled from
// RECEIVED costs an intake; cancelled from
// FILL_COMPLETED_READY_FOR_FINAL it has already consumed a typist, a
// pharmacist, a lot, a vial label, and a slot in the final-verify
// queue. "We cancel most often at PV1 for INSURANCE_DENIAL" is a
// work item — move the eligibility check to intake. "INSURANCE_DENIAL
// is our top reason" is only a fact.
//
// `cancelledFromStatus` is exactly the right column for this: the
// CancelOrder command records the status the order was cancelled out
// of, so the exit stage is on disk and needs no event replay.
//
// Which timestamp the window uses
// -------------------------------
// `cancelledAt` — when the decision was made, which is the axis the
// question is asked on ("what did we cancel last week"). The
// `(organizationId, cancelledAt)` index covers the scan.
//
// The cancellation rate, and its cohort caveat
// --------------------------------------------
// The denominator is orders RECEIVED in the same window, so "40
// cancellations" reads against the volume that produced it. The two
// sides are deliberately different cohorts: a cancellation in the
// window may belong to an order received before it, and an order
// received near the end of the window may still be cancelled after
// it. In steady state that is the operational cancellation rate
// every pharmacy tracks; during a volume spike it lags by roughly
// one order lifetime. Making both sides one cohort (cancellations OF
// orders received in-window) answers a different, slower question —
// a quality-of-intake rate that cannot be read until the cohort
// finishes — and would not use the `cancelledAt` index. When the
// `dispositions` filter narrows the numerator, the rate narrows with
// it: it becomes "share of intake volume cancelled for THESE
// reasons", which is the reading an operator who picked a subset
// expects.
//
// PHI invariant: `dispositionReasonText` is operator free-text. A
// cancellation note can name a patient, quote a phone call, or carry
// a diagnosis, so it is never selected and never reaches a row —
// only the closed `dispositionReason` enum and the workflow status
// do. `cancelledByUserId` is left out for a different reason: "who
// cancels the most" is a productivity question, and answering it
// here would put an actor column on a report whose scoping is built
// for reason analysis.

import { CancellationDisposition } from "@pharmax/database";
import type { OrderStatus } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface CancellationReasonsRow {
  readonly dispositionReason: CancellationDisposition;
  /** The workflow status the order was cancelled out of. */
  readonly cancelledFromStatus: OrderStatus;
  readonly cancellationCount: number;
  /** Share of all cancellations in the window, in basis points. */
  readonly shareOfCancellationsBps: number;
}

const DISPOSITIONS = [
  CancellationDisposition.PATIENT_REQUEST,
  CancellationDisposition.PROVIDER_REQUEST,
  CancellationDisposition.CLINIC_REQUEST,
  CancellationDisposition.INSURANCE_DENIAL,
  CancellationDisposition.INVENTORY_UNAVAILABLE,
  CancellationDisposition.DUPLICATE_ORDER,
  CancellationDisposition.DATA_ENTRY_ERROR,
  CancellationDisposition.PATIENT_INELIGIBLE,
  CancellationDisposition.OTHER,
] as const;

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /** Restrict to specific disposition reasons; omit for all nine. */
    dispositions: z.array(z.enum(DISPOSITIONS)).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type CancellationReasonsParams = z.infer<typeof paramsSchema>;

function rateBps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000);
}

export const cancellationReasonsReport: ReportDefinition<
  typeof paramsSchema,
  CancellationReasonsRow
> = {
  id: "cancellation-reasons",
  version: 1,
  title: "Cancellation reasons by exit stage",
  description:
    "Cancellations by disposition reason and the workflow status they were cancelled from, within a date range, with each pairing's share of cancellations and the cancellation rate against intake volume. Shows how much work a reason costs, not just how often it fires.",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields(),
    {
      kind: "multi-enum",
      key: "dispositions",
      label: "Disposition reasons",
      required: false,
      help: "Restrict to these cancellation reasons; leave empty for all.",
      options: DISPOSITIONS.map((d) => ({ value: d, label: d })),
    },
  ],

  async run(ctx, params): Promise<ReportResult<CancellationReasonsRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    // Cancellations carry no `clinicId` column, so clinic scope goes
    // through the order relation; orders carry it directly. BOTH
    // sides of the rate must be narrowed — scoping only the
    // numerator would divide one clinic's cancellations by the whole
    // org's intake and report a rate far below reality.
    const cancellationClinicScope =
      ctx.clinicId !== undefined ? { order: { clinicId: ctx.clinicId } } : {};
    const orderClinicScope = ctx.clinicId !== undefined ? { clinicId: ctx.clinicId } : {};

    const [groups, ordersReceived] = await Promise.all([
      ctx.client.orderCancellation.groupBy({
        by: ["dispositionReason", "cancelledFromStatus"],
        where: {
          organizationId: ctx.organizationId,
          cancelledAt: { gte: window.from, lte: window.to },
          ...(params.dispositions !== undefined && params.dispositions.length > 0
            ? { dispositionReason: { in: params.dispositions } }
            : {}),
          ...cancellationClinicScope,
        },
        _count: { _all: true },
      }),
      ctx.client.order.count({
        where: {
          organizationId: ctx.organizationId,
          receivedAt: { gte: window.from, lte: window.to },
          ...orderClinicScope,
        },
      }),
    ]);

    const totalCancellations = groups.reduce((n, g) => n + g._count._all, 0);

    const rows: CancellationReasonsRow[] = groups
      .map((g) =>
        Object.freeze({
          dispositionReason: g.dispositionReason,
          cancelledFromStatus: g.cancelledFromStatus,
          cancellationCount: g._count._all,
          shareOfCancellationsBps: rateBps(g._count._all, totalCancellations),
        })
      )
      // Costliest pairing first. Reason then exit stage as tiebreaks
      // so equal counts always serialize in the same order.
      .sort((a, b) => {
        if (b.cancellationCount !== a.cancellationCount) {
          return b.cancellationCount - a.cancellationCount;
        }
        if (a.dispositionReason !== b.dispositionReason) {
          return a.dispositionReason.localeCompare(b.dispositionReason);
        }
        return a.cancelledFromStatus.localeCompare(b.cancelledFromStatus);
      });

    const distinctReasons = new Set(rows.map((r) => r.dispositionReason)).size;

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalCancellations,
        ordersReceivedInWindow: ordersReceived,
        cancellationRateBps: rateBps(totalCancellations, ordersReceived),
        distinctReasons,
        distinctGroups: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
