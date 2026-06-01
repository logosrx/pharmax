// Verification rejection rate by stage — per-stage approved /
// rejected verification counts + rejection rate, for verification
// decisions recorded within a date range.
//
// Serves the product requirement (rules: "rejection rates",
// "rework rates"): a pharmacist REJECT at PV1 or FINAL kicks the
// order back into the rework loop, so a rising rejection rate is
// an early quality signal (typing errors, fill mistakes).
//
// One row per stage (PV1, FINAL) with approved/rejected/total +
// a rejection-rate aggregate in basis points (integer — keeps the
// per-row shape `Record<string, number>`-friendly and avoids
// float drift in the CSV). The headline aggregates roll the same
// up across both stages.
//
// PHI invariant: verification records are pharmacist-attributed
// workflow events, not patient data. Columns queried (stage,
// decision, occurredAt) are non-PHI.

import { VerificationStage } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface VerificationRejectionRateRow {
  readonly stage: VerificationStage;
  readonly approvedCount: number;
  readonly rejectedCount: number;
  readonly totalCount: number;
  readonly rejectionRateBps: number;
}

const STAGES = [VerificationStage.PV1, VerificationStage.FINAL] as const;

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /** Restrict to specific verification stages; omit for both. */
    stages: z.array(z.enum(STAGES)).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type VerificationRejectionRateParams = z.infer<typeof paramsSchema>;

function rateBps(rejected: number, total: number): number {
  return total === 0 ? 0 : Math.round((rejected / total) * 10_000);
}

export const verificationRejectionRateReport: ReportDefinition<
  typeof paramsSchema,
  VerificationRejectionRateRow
> = {
  id: "verification-rejection-rate",
  version: 1,
  title: "Verification rejection rate by stage",
  description:
    "Approved vs. rejected verification decisions per stage (PV1, FINAL) within a date range, with a rejection rate (basis points). A rising rate is an early quality / rework signal.",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields(),
    {
      kind: "multi-enum",
      key: "stages",
      label: "Stages",
      required: false,
      help: "Restrict to PV1 and/or FINAL; leave empty for both.",
      options: STAGES.map((s) => ({ value: s, label: s })),
    },
  ],

  async run(ctx, params): Promise<ReportResult<VerificationRejectionRateRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    // groupBy (stage, decision) → counts. The index
    // `(organizationId, stage, occurredAt)` (the "rejection rate
    // by stage" index) covers this scan.
    const groups = await ctx.client.verificationRecord.groupBy({
      by: ["stage", "decision"],
      where: {
        organizationId: ctx.organizationId,
        occurredAt: { gte: window.from, lte: window.to },
        ...(params.stages !== undefined && params.stages.length > 0
          ? { stage: { in: params.stages } }
          : {}),
      },
      _count: { _all: true },
    });

    // Pivot (stage, decision) groups into one row per stage.
    const perStage = new Map<VerificationStage, { approved: number; rejected: number }>();
    for (const g of groups) {
      const current = perStage.get(g.stage) ?? { approved: 0, rejected: 0 };
      if (g.decision === "APPROVED") current.approved += g._count._all;
      else current.rejected += g._count._all;
      perStage.set(g.stage, current);
    }

    const rows: VerificationRejectionRateRow[] = [...perStage.entries()]
      .map(([stage, counts]) => {
        const total = counts.approved + counts.rejected;
        return Object.freeze({
          stage,
          approvedCount: counts.approved,
          rejectedCount: counts.rejected,
          totalCount: total,
          rejectionRateBps: rateBps(counts.rejected, total),
        });
      })
      // Deterministic CSV: PV1 before FINAL (enum order).
      .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));

    const totalRejected = rows.reduce((n, r) => n + r.rejectedCount, 0);
    const totalVerifications = rows.reduce((n, r) => n + r.totalCount, 0);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalVerifications,
        totalRejected,
        overallRejectionRateBps: rateBps(totalRejected, totalVerifications),
        distinctStages: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
