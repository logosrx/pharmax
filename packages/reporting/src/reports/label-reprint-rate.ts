// Label reprint rate — reprints by reason code and the share of all
// label printing that was a reprint, over a date range.
//
// Serves the product requirement (rules: "reprint rates") and, more
// importantly, makes an existing safety rule observable. "No silent
// label reprints" and "Every label reprint requires a reason code"
// are already enforced at the command: `PrintJob` carries
// `isReprint` and `reprintReasonCode`, so a reprint cannot be
// recorded without a reason. But enforcement without visibility only
// guarantees a reason was TYPED, not that anyone ever looked. A vial
// label is the last human-readable check before a drug leaves the
// building, and a reprint means the first one was wrong, unreadable,
// or lost. This report is how a supervisor notices that one printer
// accounts for most of them, or that reprints are climbing on a
// particular shift.
//
// Denominator is every print job in the window, so the rate answers
// "what share of label printing is rework". Reprints are counted by
// `requestedAt` — when the operator asked — rather than `completedAt`,
// because a queued or failed reprint still represents rework, and
// windowing on completion would silently drop the failures.
//
// Reason code is nullable on the model (only reprints carry one), so
// a reprint row with a null code would be a bug in the print command
// rather than an expected shape. It is reported under an explicit
// bucket instead of being dropped, so it cannot hide.
//
// PHI invariant: queries only `isReprint`, `reprintReasonCode`,
// `requestedAt`, and the order relation for clinic scope. Never
// touches `renderedZpl` — that is the label body and does contain
// patient-identifying text.

import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

/** Bucket for a reprint whose reason code is unexpectedly absent. */
export const REPRINT_REASON_MISSING = "(missing)";

export interface LabelReprintRateRow {
  readonly reprintReasonCode: string;
  readonly reprintCount: number;
  /** Share of all reprints, in basis points. */
  readonly shareOfReprintsBps: number;
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

export type LabelReprintRateParams = z.infer<typeof paramsSchema>;

function rateBps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000);
}

export const labelReprintRateReport: ReportDefinition<typeof paramsSchema, LabelReprintRateRow> = {
  id: "label-reprint-rate",
  version: 1,
  title: "Label reprint rate",
  description:
    "Vial label reprints by reason code within a date range, with each reason's share of reprints and the reprint rate against all label printing. A reprint means the first label was wrong, unreadable, or lost.",
  parametersSchema: paramsSchema,
  parameterFields: [...dateRangeFields()],

  async run(ctx, params): Promise<ReportResult<LabelReprintRateRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };
    const requestedAt = { gte: window.from, lte: window.to };
    // Print jobs carry no clinicId column, so clinic scope goes
    // through the order relation — same shape as the verification
    // rejection-rate report. Required, or a clinic-scoped operator
    // would see another clinic's reprint behaviour.
    const clinicScope = ctx.clinicId !== undefined ? { order: { clinicId: ctx.clinicId } } : {};

    const [groups, printJobCount] = await Promise.all([
      ctx.client.printJob.groupBy({
        by: ["reprintReasonCode"],
        where: {
          organizationId: ctx.organizationId,
          isReprint: true,
          requestedAt,
          ...clinicScope,
        },
        _count: { _all: true },
      }),
      ctx.client.printJob.count({
        where: {
          organizationId: ctx.organizationId,
          requestedAt,
          ...clinicScope,
        },
      }),
    ]);

    const totalReprints = groups.reduce((n, g) => n + g._count._all, 0);

    const rows: LabelReprintRateRow[] = groups
      .map((g) =>
        Object.freeze({
          reprintReasonCode: g.reprintReasonCode ?? REPRINT_REASON_MISSING,
          reprintCount: g._count._all,
          shareOfReprintsBps: rateBps(g._count._all, totalReprints),
        })
      )
      // Most common reason first, code as the tiebreak for a stable CSV.
      .sort((a, b) =>
        b.reprintCount !== a.reprintCount
          ? b.reprintCount - a.reprintCount
          : a.reprintReasonCode.localeCompare(b.reprintReasonCode)
      );

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalReprints,
        totalPrintJobs: printJobCount,
        reprintRateBps: rateBps(totalReprints, printJobCount),
        distinctReasonCodes: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
