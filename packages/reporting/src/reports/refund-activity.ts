// Refund activity — every settled refund (payment-ledger REFUND
// rows) within a date range.
//
// What finance / operators use this for:
//
//   - "How much money went back out last month, and to which
//     clinics?" — the outbound side of the cash picture, paired
//     with the payments-received register.
//   - "Are refunds concentrated on one clinic or product line?" —
//     a rising refund rate is an early operational-quality signal.
//
// Source of truth: the append-only `payment` ledger. Amounts are
// always POSITIVE with direction in `kind` (the ledger's invariant),
// so this report needs no sign gymnastics — a refund row's
// `amountCents` is simply how much went back.
//
// Window is over `occurredAt` — when Stripe settled the refund, not
// when the operator clicked. An IssueRefund that Stripe held as
// `pending` over a month boundary lands in the month it SETTLED.
//
// Deliberately EXCLUDED:
//
//   - Pending refunds (line written, money not yet moved). The
//     ledger records settled money only; still-pending refunds are
//     visible operationally via the nightly reconciler's
//     `unsettledRefund*` tally, and they will appear here the day
//     the settle webhook lands.
//   - Internal credits / adjustments (CreditInvoice) — those never
//     move money and are visible on billing-summary-by-clinic.
//
// Why the ledger scan lives HERE and not in `@pharmax/billing`:
// reporting is a domain package, and domain → domain imports are
// forbidden by the package-layer fitness function
// (`scripts/check-package-layers.ts`). Reports read other domains'
// TABLES through `ctx.client` but never their code.
//
// PHI invariant: refunds are clinic-level financial records —
// invoice numbers, cents, Stripe refund ids. No patient linkage.

import { PaymentKind, PaymentMethod } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface RefundActivityRow {
  readonly paymentId: string;
  /** ISO timestamp — when the refund settled (processor time). */
  readonly occurredAt: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly clinicId: string;
  readonly method: PaymentMethod;
  /** Stripe refund id; "" for non-Stripe refunds. */
  readonly stripeRefundId: string;
  /** Always positive — direction lives in the ledger's `kind`. */
  readonly amountCents: number;
  readonly currency: string;
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

export type RefundActivityParams = z.infer<typeof paramsSchema>;

export const refundActivityReport: ReportDefinition<typeof paramsSchema, RefundActivityRow> = {
  id: "refund-activity",
  version: 1,
  title: "Refund activity",
  description:
    "Every settled refund in the date range, one row per refund with its Stripe id and invoice — the outbound counterpart to the payments-received register. Pending refunds appear once they settle.",
  parametersSchema: paramsSchema,
  parameterFields: [...dateRangeFields()],

  async run(ctx, params): Promise<ReportResult<RefundActivityRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    const refunds = await ctx.client.payment.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(ctx.clinicId !== undefined ? { clinicId: ctx.clinicId } : {}),
        kind: PaymentKind.REFUND,
        occurredAt: { gte: window.from, lte: window.to },
      },
      select: {
        id: true,
        occurredAt: true,
        invoiceId: true,
        clinicId: true,
        method: true,
        stripeRefundId: true,
        amountCents: true,
        currency: true,
        invoice: { select: { invoiceNumber: true } },
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });

    const rows: RefundActivityRow[] = refunds.map((r) =>
      Object.freeze({
        paymentId: r.id,
        occurredAt: r.occurredAt.toISOString(),
        invoiceId: r.invoiceId,
        invoiceNumber: r.invoice.invoiceNumber,
        clinicId: r.clinicId,
        method: r.method,
        stripeRefundId: r.stripeRefundId ?? "",
        amountCents: r.amountCents,
        currency: r.currency,
      })
    );

    const sumWhere = (pred: (r: RefundActivityRow) => boolean): number =>
      rows.reduce((sum, r) => (pred(r) ? sum + r.amountCents : sum), 0);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        refundCount: rows.length,
        totalRefundedCents: sumWhere(() => true),
        stripeRefundedCents: sumWhere((r) => r.method === PaymentMethod.STRIPE),
        manualRefundedCents: sumWhere((r) => r.method === PaymentMethod.MANUAL),
        distinctInvoiceCount: new Set(rows.map((r) => r.invoiceId)).size,
        distinctClinicCount: new Set(rows.map((r) => r.clinicId)).size,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
