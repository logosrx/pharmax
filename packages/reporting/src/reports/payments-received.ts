// Payments received — the payment register: every settled
// collection (payment-ledger PAYMENT rows) within a date range.
//
// What finance / operators use this for:
//
//   - "What money actually arrived last week?" — the bank-deposit
//     reconciliation view. Each row is one settled collection with
//     its method (STRIPE / MANUAL), manual instrument (check / ACH /
//     wire / cash) and bank-side reference, so an operator can tick
//     rows off against a bank statement.
//   - "How much of our collections come in by check vs. Stripe?"
//
// Source of truth: the append-only `payment` ledger, NOT invoice
// projections. `Invoice.amountPaidCents` tells you where a balance
// stands; the ledger tells you when each dollar moved — which is
// what a date-ranged cash report must sum over. (An invoice paid in
// two partial checks straddling the window boundary contributes
// only the in-window check.)
//
// Window is over `occurredAt` — when the money moved per the
// processor/bank, not when Pharmax recorded it. Backdated manual
// entries therefore land in the period the cash actually arrived.
//
// Deliberately EXCLUDED:
//
//   - REFUND rows — outbound money is the refund-activity report;
//     mixing directions in one register invites sign errors.
//   - Failed / pending collections — the ledger only records
//     settled money, so this report inherits that guarantee.
//
// CREDIT_BALANCE rows (ApplyClinicCredit settling an invoice from
// stored clinic credit) ARE included — they are real collections
// against invoices — but NO new cash arrives on them (the cash moved
// when the credit was granted). For strict bank-deposit ticking,
// filter methods to STRIPE + MANUAL.
//
// Why the ledger scan lives HERE and not in `@pharmax/billing`:
// reporting is a domain package, and domain → domain imports are
// forbidden by the package-layer fitness function
// (`scripts/check-package-layers.ts`). Reports read other domains'
// TABLES through `ctx.client` (same pattern as invoice-aging /
// billing-summary-by-clinic) but never their code.
//
// PHI invariant: payments are clinic-level financial records —
// invoice numbers, cents, Stripe ids, bank references. No patient
// linkage.

import { PaymentKind, PaymentMethod } from "@pharmax/database";
import { z } from "zod";

import { dateRangeFields } from "../parameter-fields.js";
import type { DateRangeParams, ReportDefinition, ReportResult } from "../types.js";

export interface PaymentsReceivedRow {
  readonly paymentId: string;
  /** ISO timestamp — when the money moved (processor/bank time). */
  readonly occurredAt: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly clinicId: string;
  readonly method: PaymentMethod;
  /** CHECK / ACH / WIRE / CASH / OTHER for manual payments; "" for Stripe. */
  readonly instrument: string;
  /** Bank-side reference (check number, ACH trace); "" when absent. */
  readonly referenceNumber: string;
  readonly amountCents: number;
  readonly currency: string;
}

const METHODS = [PaymentMethod.STRIPE, PaymentMethod.MANUAL, PaymentMethod.CREDIT_BALANCE] as const;

const paramsSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    /** Restrict to specific methods; omit for all. */
    methods: z.array(z.enum(METHODS)).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "from must be <= to",
    path: ["from"],
  });

export type PaymentsReceivedParams = z.infer<typeof paramsSchema>;

/** Safely pull a string field out of the ledger row's JSON metadata. */
function metadataString(metadata: unknown, key: string): string {
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export const paymentsReceivedReport: ReportDefinition<typeof paramsSchema, PaymentsReceivedRow> = {
  id: "payments-received",
  version: 1,
  title: "Payments received",
  description:
    "Every settled collection (Stripe and manual check/ACH/wire/cash) in the date range, one row per payment with method, instrument, and bank reference — the bank-reconciliation register. Sums over the payment ledger, not invoice projections.",
  parametersSchema: paramsSchema,
  parameterFields: [
    ...dateRangeFields(),
    {
      kind: "multi-enum",
      key: "methods",
      label: "Payment methods",
      required: false,
      help: "Restrict to Stripe or manual collections; leave empty for all.",
      options: METHODS.map((m) => ({ value: m, label: m })),
    },
  ],

  async run(ctx, params): Promise<ReportResult<PaymentsReceivedRow>> {
    const window: DateRangeParams = { from: params.from, to: params.to };

    const payments = await ctx.client.payment.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(ctx.clinicId !== undefined ? { clinicId: ctx.clinicId } : {}),
        kind: PaymentKind.PAYMENT,
        occurredAt: { gte: window.from, lte: window.to },
        ...(params.methods !== undefined && params.methods.length > 0
          ? { method: { in: params.methods } }
          : {}),
      },
      select: {
        id: true,
        occurredAt: true,
        invoiceId: true,
        clinicId: true,
        method: true,
        amountCents: true,
        currency: true,
        metadata: true,
        invoice: { select: { invoiceNumber: true } },
      },
      // Chronological register order; id tiebreak keeps CSV diffs
      // stable when two payments share a timestamp.
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });

    const rows: PaymentsReceivedRow[] = payments.map((p) =>
      Object.freeze({
        paymentId: p.id,
        occurredAt: p.occurredAt.toISOString(),
        invoiceId: p.invoiceId,
        invoiceNumber: p.invoice.invoiceNumber,
        clinicId: p.clinicId,
        method: p.method,
        instrument: metadataString(p.metadata, "instrument"),
        referenceNumber: metadataString(p.metadata, "referenceNumber"),
        amountCents: p.amountCents,
        currency: p.currency,
      })
    );

    const sumWhere = (pred: (r: PaymentsReceivedRow) => boolean): number =>
      rows.reduce((sum, r) => (pred(r) ? sum + r.amountCents : sum), 0);

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        paymentCount: rows.length,
        totalReceivedCents: sumWhere(() => true),
        stripeReceivedCents: sumWhere((r) => r.method === PaymentMethod.STRIPE),
        manualReceivedCents: sumWhere((r) => r.method === PaymentMethod.MANUAL),
        // Settlements from stored clinic credit — no new cash on
        // these rows; the cash arrived when the credit was granted.
        creditBalanceAppliedCents: sumWhere((r) => r.method === PaymentMethod.CREDIT_BALANCE),
        distinctInvoiceCount: new Set(rows.map((r) => r.invoiceId)).size,
        distinctClinicCount: new Set(rows.map((r) => r.clinicId)).size,
      }),
      window,
      generatedAt: ctx.asOf ?? new Date(),
    });
  },
};
