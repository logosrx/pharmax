// Invoice aging (AR) — OPEN invoices bucketed by days overdue as
// of a point in time.
//
// What finance / operators use this for:
//
//   - "How much receivable is outstanding right now, and how stale
//     is it?"
//   - "Which clinics are carrying 60/90+ day balances that need a
//     collections conversation?"
//
// Unlike the date-range reports, this is a POINT-IN-TIME report:
// it takes a single `asOf` date (default: today) and classifies
// every OPEN invoice into the canonical AR buckets (CURRENT,
// 1-30, 31-60, 61-90, 90+). What it deliberately EXCLUDES:
//
//   - DRAFT invoices (not yet finalized, totals may still change).
//   - PAID invoices (collected; not part of AR).
//   - VOID / UNCOLLECTIBLE invoices (written off).
//
// Why the bucket math lives HERE and not in `@pharmax/billing`:
// reporting is a domain package, and domain -> domain imports are
// forbidden by the package-layer fitness function
// (`scripts/check-package-layers.ts`). Reports read other domains'
// TABLES through `ctx.client` (same pattern as
// billing-summary-by-clinic) but never their code. The buckets are
// the industry-canonical AR bands and MUST stay in sync with
// `listAgedInvoices` in `@pharmax/billing` (the operator billing
// UI's aging query) — both sides carry this pointer.
//
// PHI invariant: invoices are clinic-level financial records —
// invoice number, clinic id, cents amounts, dates. No patient
// linkage.

import { InvoiceStatus } from "@pharmax/database";
import { z } from "zod";

import type { ReportDefinition, ReportResult } from "../types.js";

export const AGING_BUCKETS = [
  "CURRENT",
  "DAYS_1_30",
  "DAYS_31_60",
  "DAYS_61_90",
  "DAYS_OVER_90",
] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface InvoiceAgingRow {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly clinicId: string;
  readonly currency: string;
  readonly totalCents: number;
  readonly amountDueCents: number;
  readonly issuedAt: string; // YYYY-MM-DD, "" when unset
  readonly dueAt: string; // YYYY-MM-DD, "" when unset
  readonly daysOverdue: number;
  readonly bucket: AgingBucket;
}

const paramsSchema = z
  .object({
    /** Point in time the aging is computed against. Defaults to
     *  "now" (the command's clock) when omitted. */
    asOf: z.date().optional(),
  })
  .strict();

export type InvoiceAgingParams = z.infer<typeof paramsSchema>;

const MS_PER_DAY = 24 * 60 * 60_000;

/** Keep in sync with `classifyAgingBucket` in `@pharmax/billing`. */
export function classifyAgingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "CURRENT";
  if (daysOverdue <= 30) return "DAYS_1_30";
  if (daysOverdue <= 60) return "DAYS_31_60";
  if (daysOverdue <= 90) return "DAYS_61_90";
  return "DAYS_OVER_90";
}

/** Aggregate-key prefix per bucket (camelCase for the tiles UI). */
const BUCKET_AGGREGATE_PREFIX: Readonly<Record<AgingBucket, string>> = {
  CURRENT: "current",
  DAYS_1_30: "days1To30",
  DAYS_31_60: "days31To60",
  DAYS_61_90: "days61To90",
  DAYS_OVER_90: "over90",
};

function toDateString(value: Date | null): string {
  return value === null ? "" : value.toISOString().slice(0, 10);
}

export const invoiceAgingReport: ReportDefinition<typeof paramsSchema, InvoiceAgingRow> = {
  id: "invoice-aging",
  version: 1,
  title: "Invoice aging (AR)",
  description:
    "OPEN invoices bucketed by days overdue (current, 1-30, 31-60, 61-90, 90+) as of a point in time, most-overdue first. Drafts and settled invoices are excluded.",
  parametersSchema: paramsSchema,
  parameterFields: [
    {
      kind: "date",
      key: "asOf",
      label: "As of",
      required: false,
      help: "Compute aging as of the end of this day. Leave blank for now.",
      defaultValue: "today",
      // Aging "as of July 1" should include the full day — an
      // invoice due July 1 is CURRENT, not 1 day overdue.
      endOfDay: true,
    },
  ],

  async run(ctx, params): Promise<ReportResult<InvoiceAgingRow>> {
    const asOf = params.asOf ?? ctx.asOf ?? new Date();
    const asOfMs = asOf.getTime();

    const invoices = await ctx.client.invoice.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: InvoiceStatus.OPEN,
        ...(ctx.clinicId !== undefined ? { clinicId: ctx.clinicId } : {}),
      },
      select: {
        id: true,
        invoiceNumber: true,
        clinicId: true,
        currency: true,
        totalCents: true,
        amountDueCents: true,
        issuedAt: true,
        dueAt: true,
      },
      // Oldest due date first = most overdue first — the order
      // finance wants, and deterministic for CSV diffs.
      orderBy: [{ dueAt: "asc" }, { issuedAt: "asc" }],
    });

    const rows: InvoiceAgingRow[] = invoices.map((inv) => {
      const dueAtMs = inv.dueAt?.getTime() ?? null;
      // No due date → treat as current (defensive default;
      // FinalizeInvoice always sets dueAt).
      const daysOverdue =
        dueAtMs === null ? 0 : Math.max(0, Math.floor((asOfMs - dueAtMs) / MS_PER_DAY));
      return Object.freeze({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        clinicId: inv.clinicId,
        currency: inv.currency,
        totalCents: inv.totalCents,
        amountDueCents: inv.amountDueCents,
        issuedAt: toDateString(inv.issuedAt),
        dueAt: toDateString(inv.dueAt),
        daysOverdue,
        bucket: classifyAgingBucket(daysOverdue),
      });
    });

    const aggregates: Record<string, number> = {
      invoiceCount: rows.length,
      totalAmountDueCents: rows.reduce((sum, r) => sum + r.amountDueCents, 0),
    };
    for (const bucket of AGING_BUCKETS) {
      const prefix = BUCKET_AGGREGATE_PREFIX[bucket];
      const inBucket = rows.filter((r) => r.bucket === bucket);
      aggregates[`${prefix}Count`] = inBucket.length;
      aggregates[`${prefix}AmountDueCents`] = inBucket.reduce(
        (sum, r) => sum + r.amountDueCents,
        0
      );
    }

    return Object.freeze({
      rows,
      aggregates: Object.freeze(aggregates),
      // Point-in-time report: the window degenerates to [asOf, asOf].
      window: { from: asOf, to: asOf },
      generatedAt: asOf,
    });
  },
};
