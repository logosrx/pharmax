// Read-only invoice projection helpers for the operator console.
//
// Two helpers:
//
//   - `listInvoices` — paginated invoice list for the
//     `/ops/billing` page. Supports optional `status` + `clinicId`
//     filters. Returns presentation rows (no lines — those are
//     loaded per-invoice in the detail view).
//
//   - `getInvoiceDetail` — a single invoice plus its lines for the
//     `/ops/billing/[invoiceId]` detail view. Returns `null` when
//     the invoice does not exist in the operator's tenancy.
//
// Tenancy: callers are required to have resolved a TenancyContext
// FIRST. The query still passes an explicit `organizationId`
// predicate as defense in depth — RLS would block cross-org reads
// anyway, but the predicate is the suspenders to RLS's belt.
//
// PHI: invoices reference clinics, not patients; line descriptions
// are sanitized at materialization time (currently a flat dispense-fee
// label). No PHI columns surface.

import "server-only";

import { readInOrgScope, type InvoiceLineKind, type InvoiceStatus } from "@pharmax/database";

export interface InvoiceListRow {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly clinicId: string;
  readonly status: InvoiceStatus;
  readonly currency: string;
  readonly subtotalCents: number;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly amountDueCents: number;
  readonly issuedAt: Date | null;
  readonly dueAt: Date | null;
  readonly paidAt: Date | null;
  readonly stripeInvoiceId: string | null;
  readonly lineCount: number;
  readonly version: number;
  readonly createdAt: Date;
}

export interface ListInvoicesOptions {
  readonly organizationId: string;
  readonly status?: InvoiceStatus;
  readonly clinicId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListInvoicesResult {
  readonly rows: ReadonlyArray<InvoiceListRow>;
  /** Cursor for the next page; null when no more rows. */
  readonly nextCursor: string | null;
}

export async function listInvoices(options: ListInvoicesOptions): Promise<ListInvoicesResult> {
  const limit = Math.min(options.limit ?? 50, 200);

  return readInOrgScope(options.organizationId, async (tx) => {
    const rows = await tx.invoice.findMany({
      where: {
        organizationId: options.organizationId,
        ...(options.status !== undefined ? { status: options.status } : {}),
        ...(options.clinicId !== undefined ? { clinicId: options.clinicId } : {}),
      },
      select: {
        id: true,
        invoiceNumber: true,
        clinicId: true,
        status: true,
        currency: true,
        subtotalCents: true,
        totalCents: true,
        amountPaidCents: true,
        amountDueCents: true,
        issuedAt: true,
        dueAt: true,
        paidAt: true,
        stripeInvoiceId: true,
        version: true,
        createdAt: true,
        _count: { select: { lines: true } },
      },
      orderBy: [{ createdAt: "desc" }],
      take: limit + 1,
      ...(options.cursor !== undefined ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? sliced[sliced.length - 1]!.id : null;

    return Object.freeze({
      rows: sliced.map((r) =>
        Object.freeze({
          invoiceId: r.id,
          invoiceNumber: r.invoiceNumber,
          clinicId: r.clinicId,
          status: r.status,
          currency: r.currency,
          subtotalCents: r.subtotalCents,
          totalCents: r.totalCents,
          amountPaidCents: r.amountPaidCents,
          amountDueCents: r.amountDueCents,
          issuedAt: r.issuedAt,
          dueAt: r.dueAt,
          paidAt: r.paidAt,
          stripeInvoiceId: r.stripeInvoiceId,
          lineCount: r._count.lines,
          version: r.version,
          createdAt: r.createdAt,
        })
      ),
      nextCursor,
    });
  });
}

export interface InvoiceDetailLine {
  readonly invoiceLineId: string;
  readonly kind: InvoiceLineKind;
  readonly description: string;
  readonly quantity: string;
  readonly unitAmountCents: number;
  readonly amountCents: number;
  readonly orderId: string | null;
  readonly createdAt: Date;
}

export interface InvoiceDetail {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly clinicId: string;
  readonly status: InvoiceStatus;
  readonly currency: string;
  readonly subtotalCents: number;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly amountDueCents: number;
  readonly issuedAt: Date | null;
  readonly dueAt: Date | null;
  readonly paidAt: Date | null;
  readonly voidedAt: Date | null;
  readonly stripeInvoiceId: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeChargeId: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly lines: ReadonlyArray<InvoiceDetailLine>;
}

export async function getInvoiceDetail(input: {
  readonly organizationId: string;
  readonly invoiceId: string;
}): Promise<InvoiceDetail | null> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const row = await tx.invoice.findFirst({
      where: { id: input.invoiceId, organizationId: input.organizationId },
      select: {
        id: true,
        invoiceNumber: true,
        clinicId: true,
        status: true,
        currency: true,
        subtotalCents: true,
        totalCents: true,
        amountPaidCents: true,
        amountDueCents: true,
        issuedAt: true,
        dueAt: true,
        paidAt: true,
        voidedAt: true,
        stripeInvoiceId: true,
        stripeCustomerId: true,
        stripeChargeId: true,
        version: true,
        createdAt: true,
        lines: {
          select: {
            id: true,
            kind: true,
            description: true,
            quantity: true,
            unitAmountCents: true,
            amountCents: true,
            orderId: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (row === null) return null;
    return Object.freeze({
      invoiceId: row.id,
      invoiceNumber: row.invoiceNumber,
      clinicId: row.clinicId,
      status: row.status,
      currency: row.currency,
      subtotalCents: row.subtotalCents,
      totalCents: row.totalCents,
      amountPaidCents: row.amountPaidCents,
      amountDueCents: row.amountDueCents,
      issuedAt: row.issuedAt,
      dueAt: row.dueAt,
      paidAt: row.paidAt,
      voidedAt: row.voidedAt,
      stripeInvoiceId: row.stripeInvoiceId,
      stripeCustomerId: row.stripeCustomerId,
      stripeChargeId: row.stripeChargeId,
      version: row.version,
      createdAt: row.createdAt,
      lines: row.lines.map((l) =>
        Object.freeze({
          invoiceLineId: l.id,
          kind: l.kind,
          description: l.description,
          quantity: String(l.quantity),
          unitAmountCents: l.unitAmountCents,
          amountCents: l.amountCents,
          orderId: l.orderId,
          createdAt: l.createdAt,
        })
      ),
    });
  });
}
