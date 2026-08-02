// Shared finalization core — the single implementation of the
// DRAFT → OPEN mutation, used by BOTH finalize entry points:
//
//   - `FinalizeInvoice` (tenant command) — the operator's explicit
//     "finalize now" click.
//   - `AutoFinalizeDueInvoice` (system command) — the period-boundary
//     cron finalizing APPROVED drafts whose billing period ended.
//
// Why one core: the guards here are FINANCIAL INVARIANTS (no empty
// invoices, no unreviewed invoices, no stale approvals, CAS on
// version), and two hand-maintained copies of an invariant is how
// invariants die. The entry points differ only in actor semantics
// (human vs. machine), permissions, and the extra period-boundary
// guard the cron applies — everything that touches the invoice row
// lives here.
//
// Error codes keep their historical FINALIZE_INVOICE_* names (they
// are re-exported from `finalize-invoice.ts`, the public API path)
// so UI discriminators and runbook grep patterns stay valid.

import type { OutboxEventDraft, PrismaTxClient } from "@pharmax/command-bus";
import { InvoiceStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

export const FINALIZE_INVOICE_NOT_FOUND = "FINALIZE_INVOICE_NOT_FOUND";
export const FINALIZE_INVOICE_EMPTY = "FINALIZE_INVOICE_EMPTY";
export const FINALIZE_INVOICE_NOT_APPROVED = "FINALIZE_INVOICE_NOT_APPROVED";
export const FINALIZE_INVOICE_APPROVAL_STALE = "FINALIZE_INVOICE_APPROVAL_STALE";
export const FINALIZE_INVOICE_VERSION_MISMATCH = "FINALIZE_INVOICE_VERSION_MISMATCH";

/** Everything both finalize entry points need from the invoice row. */
export interface FinalizableInvoice {
  readonly id: string;
  readonly clinicId: string;
  readonly invoiceNumber: string;
  readonly status: InvoiceStatus;
  readonly currency: string;
  readonly subtotalCents: number;
  readonly totalCents: number;
  readonly amountDueCents: number;
  readonly billingPeriodEnd: Date | null;
  readonly issuedAt: Date | null;
  readonly dueAt: Date | null;
  readonly approvedAt: Date | null;
  readonly approvedByUserId: string | null;
  readonly approvedVersion: number | null;
  readonly version: number;
  readonly lineCount: number;
}

export async function loadInvoiceForFinalize(
  tx: PrismaTxClient,
  input: { readonly invoiceId: string; readonly organizationId: string }
): Promise<FinalizableInvoice | null> {
  const row = await tx.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: {
      id: true,
      clinicId: true,
      invoiceNumber: true,
      status: true,
      currency: true,
      subtotalCents: true,
      totalCents: true,
      amountDueCents: true,
      billingPeriodEnd: true,
      issuedAt: true,
      dueAt: true,
      approvedAt: true,
      approvedByUserId: true,
      approvedVersion: true,
      version: true,
      _count: { select: { lines: true } },
    },
  });
  if (row === null) return null;
  const { _count, ...rest } = row;
  return { ...rest, lineCount: _count.lines };
}

/**
 * The pre-mutation gate, shared verbatim by both entry points.
 * Assumes the caller already handled the non-DRAFT short-circuit
 * (both entry points treat non-DRAFT as "already finalized", not
 * an error).
 *
 * Order matters for operator ergonomics: an empty invoice is a
 * structural problem the reviewer can't fix by approving, so it
 * fires before the approval checks.
 */
export function assertReadyToFinalize(invoice: FinalizableInvoice): void {
  if (invoice.lineCount === 0) {
    throw new errors.ValidationError({
      code: FINALIZE_INVOICE_EMPTY,
      message: "Cannot finalize an invoice with zero lines.",
      metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
    });
  }

  // ---- Approval gate ----
  // Finalization requires a FRESH approval. Two distinct codes so
  // callers can say "needs review" vs. "lines changed since the
  // review — re-approve".
  if (invoice.approvedAt === null) {
    throw new errors.ConflictError({
      code: FINALIZE_INVOICE_NOT_APPROVED,
      message:
        "Invoice has not been approved. Review the draft and run ApproveInvoice before finalizing.",
      metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
    });
  }
  if (invoice.approvedVersion !== invoice.version) {
    throw new errors.ConflictError({
      code: FINALIZE_INVOICE_APPROVAL_STALE,
      message:
        "Invoice lines changed after the approval — the review is stale. Re-approve the invoice before finalizing.",
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        approvedVersion: invoice.approvedVersion,
        currentVersion: invoice.version,
      },
    });
  }
}

export interface FinalizeCasResult {
  readonly issuedAt: Date;
  readonly dueAt: Date;
  readonly nextVersion: number;
}

/**
 * The DRAFT → OPEN mutation itself. `updateMany where: { id, version }`
 * returns count=1 on hit, count=0 if a concurrent writer already
 * bumped the version — surfaced as a typed conflict so the caller
 * can retry / re-read fresh state.
 */
export async function performFinalizeCas(
  tx: PrismaTxClient,
  input: {
    readonly invoice: FinalizableInvoice;
    readonly daysUntilDue: number;
    readonly now: Date;
  }
): Promise<FinalizeCasResult> {
  const issuedAt = input.now;
  const dueAt = new Date(input.now.getTime() + input.daysUntilDue * 24 * 60 * 60_000);
  const nextVersion = input.invoice.version + 1;

  const updated = await tx.invoice.updateMany({
    where: { id: input.invoice.id, version: input.invoice.version },
    data: {
      status: InvoiceStatus.OPEN,
      issuedAt,
      dueAt,
      version: nextVersion,
    },
  });
  if (updated.count !== 1) {
    throw new errors.ConflictError({
      code: FINALIZE_INVOICE_VERSION_MISMATCH,
      message:
        "Invoice version was bumped by a concurrent finalization. Refresh the invoice and retry.",
      metadata: {
        invoiceId: input.invoice.id,
        attemptedVersion: input.invoice.version,
      },
    });
  }

  return { issuedAt, dueAt, nextVersion };
}

/**
 * The `billing.invoice.finalized.v1` outbox draft. Identical payload
 * from both entry points — the Stripe push handler downstream treats
 * operator-finalized and cron-finalized invoices uniformly.
 */
export function invoiceFinalizedOutboxEvent(input: {
  readonly organizationId: string;
  readonly invoice: FinalizableInvoice;
  readonly cas: FinalizeCasResult;
  readonly occurredAt: Date;
}): OutboxEventDraft {
  return {
    eventType: "billing.invoice.finalized.v1",
    aggregateType: "Invoice",
    aggregateId: input.invoice.id,
    payload: {
      organizationId: input.organizationId,
      clinicId: input.invoice.clinicId,
      invoiceId: input.invoice.id,
      invoiceNumber: input.invoice.invoiceNumber,
      currency: input.invoice.currency,
      subtotalCents: input.invoice.subtotalCents,
      totalCents: input.invoice.totalCents,
      amountDueCents: input.invoice.amountDueCents,
      lineCount: input.invoice.lineCount,
      issuedAt: input.cas.issuedAt.toISOString(),
      dueAt: input.cas.dueAt.toISOString(),
      occurredAt: input.occurredAt.toISOString(),
    },
  };
}
