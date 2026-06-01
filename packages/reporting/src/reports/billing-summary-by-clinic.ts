// Billing summary by clinic — invoice totals grouped by clinic +
// status for invoices issued within a date range.
//
// What operators / finance use this for:
//
//   - "What did we invoice each clinic last month, and how much is
//     still OPEN vs. PAID?"
//   - "Which clinics carry the most outstanding (amountDue) this
//     quarter?"
//
// Window is over `issuedAt` (not createdAt) so DRAFT invoices
// without an issue date are naturally excluded — the report is
// about money actually billed, not work-in-progress drafts.
//
// PHI invariant: invoices are clinic-level financial records, not
// patient records. Columns queried are non-PHI (clinicId, status,
// cents totals, issuedAt).

import { InvoiceStatus } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface BillingSummaryByClinicRow {
  readonly clinicId: string;
  readonly status: InvoiceStatus;
  readonly invoiceCount: number;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly amountDueCents: number;
}

const STATUSES = [
  InvoiceStatus.DRAFT,
  InvoiceStatus.OPEN,
  InvoiceStatus.PAID,
  InvoiceStatus.VOID,
  InvoiceStatus.UNCOLLECTIBLE,
] as const;

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /** Restrict to specific invoice statuses; omit for all. */
    statuses: z.array(z.enum(STATUSES)).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type BillingSummaryByClinicParams = z.infer<typeof paramsSchema>;

export const billingSummaryByClinicReport: ReportDefinition<
  typeof paramsSchema,
  BillingSummaryByClinicRow
> = {
  id: "billing-summary-by-clinic",
  version: 1,
  title: "Billing summary by clinic",
  description:
    "Invoice totals (count, total, paid, due) grouped by clinic + status, for invoices issued within a date range. Drafts without an issue date are excluded.",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields(),
    {
      kind: "multi-enum",
      key: "statuses",
      label: "Invoice statuses",
      required: false,
      help: "Restrict to these statuses; leave empty for all.",
      options: STATUSES.map((s) => ({ value: s, label: s })),
    },
  ],

  async run(ctx, params): Promise<ReportResult<BillingSummaryByClinicRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    const groups = await ctx.client.invoice.groupBy({
      by: ["clinicId", "status"],
      where: {
        organizationId: ctx.organizationId,
        ...(ctx.clinicId !== undefined ? { clinicId: ctx.clinicId } : {}),
        issuedAt: { gte: window.from, lte: window.to },
        ...(params.statuses !== undefined && params.statuses.length > 0
          ? { status: { in: params.statuses } }
          : {}),
      },
      _count: { _all: true },
      _sum: { totalCents: true, amountPaidCents: true, amountDueCents: true },
    });

    const rows: BillingSummaryByClinicRow[] = groups
      .map((g) =>
        Object.freeze({
          clinicId: g.clinicId,
          status: g.status,
          invoiceCount: g._count._all,
          totalCents: g._sum.totalCents ?? 0,
          amountPaidCents: g._sum.amountPaidCents ?? 0,
          amountDueCents: g._sum.amountDueCents ?? 0,
        })
      )
      // Deterministic CSV: clinic then status (enum order).
      .sort((a, b) => {
        if (a.clinicId !== b.clinicId) return a.clinicId < b.clinicId ? -1 : 1;
        return STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status);
      });

    const totalInvoicedCents = rows.reduce((s, r) => s + r.totalCents, 0);
    const totalPaidCents = rows.reduce((s, r) => s + r.amountPaidCents, 0);
    const totalDueCents = rows.reduce((s, r) => s + r.amountDueCents, 0);
    const invoiceCount = rows.reduce((s, r) => s + r.invoiceCount, 0);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        invoiceCount,
        totalInvoicedCents,
        totalPaidCents,
        totalDueCents,
        distinctGroups: rows.length,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
