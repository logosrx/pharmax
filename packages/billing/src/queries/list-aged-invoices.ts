// listAgedInvoices — operator aging-report query.
//
// Buckets OPEN invoices by days-overdue relative to `asOf`. The
// canonical AR aging buckets are:
//
//   CURRENT      — not yet due (dueAt > asOf), or due today
//   DAYS_1_30    — 1..30 days past due
//   DAYS_31_60   — 31..60 days past due
//   DAYS_61_90   — 61..90 days past due
//   DAYS_OVER_90 — 91+ days past due
//
// What it does NOT include:
//
//   - DRAFT invoices (not yet finalized, totals may still change).
//   - PAID invoices (collected; not part of AR).
//   - VOID / UNCOLLECTIBLE invoices (written off; surface via a
//     separate "written-off" report).
//
// Implementation:
//
//   - Pure read with tenant-scoped query. The bucket computation
//     is done in TypeScript (not SQL) because the date math is
//     simpler and the result set per org is small (the worst case
//     is a few thousand open invoices, well below the threshold
//     where a server-side aggregation would matter).
//   - Returns BOTH per-clinic and per-org aggregates so the
//     operator UI can render summary tiles + a drill-down table
//     from one call.
//
// PHI: no PHI. Invoices reference clinics, not patients.

import type { PrismaClient } from "@pharmax/database";
import { InvoiceStatus } from "@pharmax/database";

export const AGING_BUCKETS = [
  "CURRENT",
  "DAYS_1_30",
  "DAYS_31_60",
  "DAYS_61_90",
  "DAYS_OVER_90",
] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface AgedInvoiceRow {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly clinicId: string;
  readonly currency: string;
  readonly totalCents: number;
  readonly amountDueCents: number;
  readonly issuedAt: Date | null;
  readonly dueAt: Date | null;
  readonly daysOverdue: number;
  readonly bucket: AgingBucket;
}

export interface AgingBucketTotals {
  readonly bucket: AgingBucket;
  readonly invoiceCount: number;
  readonly totalAmountDueCents: number;
}

export interface ClinicAging {
  readonly clinicId: string;
  readonly invoiceCount: number;
  readonly totalAmountDueCents: number;
  readonly buckets: ReadonlyArray<AgingBucketTotals>;
}

export interface AgingReport {
  readonly organizationId: string;
  readonly asOf: Date;
  readonly invoices: ReadonlyArray<AgedInvoiceRow>;
  readonly buckets: ReadonlyArray<AgingBucketTotals>;
  readonly byClinic: ReadonlyArray<ClinicAging>;
}

export interface ListAgedInvoicesOptions {
  readonly organizationId: string;
  /**
   * Restrict to a single clinic. Omit to include every clinic in
   * the org. Useful for clinic-detail pages.
   */
  readonly clinicId?: string;
  /** Timestamp the report is computed against. Defaults to "now". */
  readonly asOf?: Date;
}

const MS_PER_DAY = 24 * 60 * 60_000;

export function classifyAgingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "CURRENT";
  if (daysOverdue <= 30) return "DAYS_1_30";
  if (daysOverdue <= 60) return "DAYS_31_60";
  if (daysOverdue <= 90) return "DAYS_61_90";
  return "DAYS_OVER_90";
}

interface MutableBucketTotals {
  bucket: AgingBucket;
  invoiceCount: number;
  totalAmountDueCents: number;
}

function emptyBucketTotals(): MutableBucketTotals[] {
  return AGING_BUCKETS.map((bucket) => ({
    bucket,
    invoiceCount: 0,
    totalAmountDueCents: 0,
  }));
}

/**
 * Read-only aging report for an org (optionally narrowed to one
 * clinic). The caller is expected to wrap this in a tenancy
 * context — the underlying Prisma client enforces RLS on the
 * `invoice` table.
 */
export async function listAgedInvoices(
  client: PrismaClient,
  options: ListAgedInvoicesOptions
): Promise<AgingReport> {
  const asOf = options.asOf ?? new Date();
  const asOfMs = asOf.getTime();

  const rows = await client.invoice.findMany({
    where: {
      organizationId: options.organizationId,
      status: InvoiceStatus.OPEN,
      ...(options.clinicId !== undefined ? { clinicId: options.clinicId } : {}),
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
    orderBy: [{ dueAt: "asc" }, { issuedAt: "asc" }],
  });

  const orgBuckets: MutableBucketTotals[] = emptyBucketTotals();
  const byClinic = new Map<string, { rows: AgedInvoiceRow[]; buckets: MutableBucketTotals[] }>();
  const invoices: AgedInvoiceRow[] = [];

  for (const row of rows) {
    const dueAtMs = row.dueAt?.getTime() ?? null;
    // No due date → treat as current (defensive default; FinalizeInvoice
    // always sets dueAt).
    const daysOverdue =
      dueAtMs === null ? 0 : Math.max(0, Math.floor((asOfMs - dueAtMs) / MS_PER_DAY));
    const bucket = classifyAgingBucket(daysOverdue);

    const aged: AgedInvoiceRow = Object.freeze({
      invoiceId: row.id,
      invoiceNumber: row.invoiceNumber,
      clinicId: row.clinicId,
      currency: row.currency,
      totalCents: row.totalCents,
      amountDueCents: row.amountDueCents,
      issuedAt: row.issuedAt,
      dueAt: row.dueAt,
      daysOverdue,
      bucket,
    });
    invoices.push(aged);

    const orgEntry = orgBuckets.find((b) => b.bucket === bucket)!;
    orgEntry.invoiceCount += 1;
    orgEntry.totalAmountDueCents += row.amountDueCents;

    const clinicEntry =
      byClinic.get(row.clinicId) ??
      (() => {
        const fresh = { rows: [] as AgedInvoiceRow[], buckets: emptyBucketTotals() };
        byClinic.set(row.clinicId, fresh);
        return fresh;
      })();
    clinicEntry.rows.push(aged);
    const clinicBucketEntry = clinicEntry.buckets.find((b) => b.bucket === bucket)!;
    clinicBucketEntry.invoiceCount += 1;
    clinicBucketEntry.totalAmountDueCents += row.amountDueCents;
  }

  const byClinicOut: ClinicAging[] = Array.from(byClinic.entries()).map(([clinicId, entry]) => ({
    clinicId,
    invoiceCount: entry.rows.length,
    totalAmountDueCents: entry.rows.reduce((sum, r) => sum + r.amountDueCents, 0),
    buckets: entry.buckets.map((b) => Object.freeze({ ...b })),
  }));

  return Object.freeze({
    organizationId: options.organizationId,
    asOf,
    invoices,
    buckets: orgBuckets.map((b) => Object.freeze({ ...b })),
    byClinic: byClinicOut,
  });
}
