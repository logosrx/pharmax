// FinalizeInvoice — DRAFT → OPEN transition for a billing-period
// invoice, locking it for further line appends and triggering the
// downstream Stripe push pipeline.
//
// Lifecycle:
//
//   DRAFT (accepts new lines)
//     → FinalizeInvoice
//   OPEN  (no new lines; awaiting Stripe push + collection)
//     → (worker) push to Stripe → write stripeInvoiceId
//     → (Stripe) payment → webhook → status flips PAID
//
// Why a manual finalize step (vs. auto-finalize on period boundary):
//
//   - A human (`BillingManager`) is required to review per-clinic
//     totals before the operator-facing "send invoice" action.
//     Auto-finalize is a future option once dispute / discount
//     workflows mature; for v1, explicit finalization keeps the
//     operator in the loop.
//
//   - The bill-out moment is the right place for last-minute
//     adjustments (credits, manual corrections). Once finalized,
//     adjustments need a corrective `CreditNote` flow rather than
//     direct line edits.
//
// Idempotency:
//
//   - The bus's idempotency cache short-circuits a re-dispatch of
//     the same finalization request.
//   - The "already OPEN / PAID / VOID" branch inside the handler
//     short-circuits subsequent calls AT THE DB LAYER: returns
//     `alreadyFinalized: true` without mutating, writes a tiny
//     audit row so the operator's repeated click is recorded but
//     does NOT bump the version or re-emit the outbox event.
//   - The CAS on `version` makes concurrent finalize calls safe:
//     the second loser of the race sees the post-mutation row and
//     short-circuits the same way.
//
// Output:
//
//   - `stripeInvoiceId` is intentionally NOT set here. The Stripe
//     push happens in the worker after this command's outbox row
//     drains; a separate `RecordStripeInvoicePushed` SystemCommand
//     writes the linkage back. Coupling the Stripe SDK to the
//     synchronous request path would put HTTP latency + outage
//     surface in front of the operator's click — wrong tradeoff.
//
// PHI invariant: no PHI is read or written. Invoices reference
// clinics, not patients; line descriptions are sanitized at
// materialization time.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { InvoiceStatus, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { getMeter } from "@pharmax/telemetry";
import { z } from "zod";

const meter = getMeter("@pharmax/billing");

const billingInvoiceFinalizedCounter = meter.createCounter(
  "pharmax_billing_invoice_finalized_total",
  {
    description:
      "Invoices transitioned DRAFT → OPEN via FinalizeInvoice. Idempotent re-finalizations (alreadyFinalized=true) are NOT counted.",
  }
);

export const FINALIZE_INVOICE_NOT_FOUND = "FINALIZE_INVOICE_NOT_FOUND";
export const FINALIZE_INVOICE_EMPTY = "FINALIZE_INVOICE_EMPTY";
export const FINALIZE_INVOICE_VERSION_MISMATCH = "FINALIZE_INVOICE_VERSION_MISMATCH";

const inputSchema = z
  .object({
    invoiceId: z.uuid(),
    /**
     * Days until due, computed forward from finalize time. v1 uses
     * a hardcoded 30 if omitted; the operator can override per
     * invoice via the UI. (Per-clinic default lives in a future
     * `BillingTerms` table; until then, callers pass it explicitly
     * or accept the v1 default.)
     */
    daysUntilDue: z.number().int().min(0).max(365).default(30),
  })
  .strict();

export type FinalizeInvoiceInput = z.infer<typeof inputSchema>;

export interface FinalizeInvoiceOutput {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly status: InvoiceStatus;
  readonly issuedAt: string;
  readonly dueAt: string;
  readonly subtotalCents: number;
  readonly totalCents: number;
  readonly lineCount: number;
  readonly version: number;
  /** `true` if the invoice was already non-DRAFT — no mutation occurred. */
  readonly alreadyFinalized: boolean;
}

export const FinalizeInvoice: Command<FinalizeInvoiceInput, FinalizeInvoiceOutput> = {
  name: "FinalizeInvoice",
  inputSchema,
  permission: PERMISSIONS.BILLING_FINALIZE_INVOICE,

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<FinalizeInvoiceOutput>> {
    // ---- Load the invoice scoped to this tenancy ----
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, organizationId: ctx.organizationId },
      select: {
        id: true,
        clinicId: true,
        invoiceNumber: true,
        status: true,
        currency: true,
        subtotalCents: true,
        totalCents: true,
        amountDueCents: true,
        issuedAt: true,
        dueAt: true,
        version: true,
        _count: { select: { lines: true } },
      },
    });
    if (invoice === null) {
      throw new errors.NotFoundError({
        code: FINALIZE_INVOICE_NOT_FOUND,
        message: "Invoice not found in this organization.",
        metadata: { invoiceId: input.invoiceId },
      });
    }

    // ---- Already-finalized short-circuit ----
    // Re-issue is a real operator pattern (double-click on the
    // "Finalize" button, retry after a network blip). Treat any
    // non-DRAFT status as "already finalized" and return the
    // current row state — no version bump, no outbox emit.
    if (invoice.status !== InvoiceStatus.DRAFT) {
      const now = clock.now();
      return {
        output: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          issuedAt: (invoice.issuedAt ?? now).toISOString(),
          dueAt: (invoice.dueAt ?? now).toISOString(),
          subtotalCents: invoice.subtotalCents,
          totalCents: invoice.totalCents,
          lineCount: invoice._count.lines,
          version: invoice.version,
          alreadyFinalized: true,
        },
        audit: {
          action: "billing.invoice.finalize.skipped",
          resourceType: "Invoice",
          resourceId: invoice.id,
          metadata: {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            currentStatus: invoice.status,
            reason: "already-finalized",
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: [],
      };
    }

    // ---- Empty-invoice guard ----
    // Finalizing an empty invoice is almost always a UX bug
    // (operator clicked finalize on a draft with no lines). Fail
    // loudly with a typed code so the UI can show a clear "this
    // invoice has no lines" message instead of pushing a $0
    // invoice to Stripe.
    if (invoice._count.lines === 0) {
      throw new errors.ValidationError({
        code: FINALIZE_INVOICE_EMPTY,
        message: "Cannot finalize an invoice with zero lines.",
        metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
      });
    }

    // ---- Compute timestamps ----
    const now = clock.now();
    const issuedAt = now;
    const dueAt = new Date(now.getTime() + input.daysUntilDue * 24 * 60 * 60_000);
    const nextVersion = invoice.version + 1;

    // ---- CAS update ----
    // `updateMany where: { id, version }` returns count=1 on hit,
    // count=0 if a concurrent finalize already bumped the version.
    // We surface the count=0 case as a typed conflict so the caller
    // can retry / re-read fresh state.
    const updated = await tx.invoice.updateMany({
      where: { id: invoice.id, version: invoice.version },
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
          invoiceId: invoice.id,
          attemptedVersion: invoice.version,
        },
      });
    }

    // Metric emit AFTER the CAS succeeds. If the surrounding tx
    // rolls back, the counter is off by 1 — acceptable for a
    // dashboard signal. Auditors verify finalize state from
    // audit_log + outbox, not from metrics.
    billingInvoiceFinalizedCounter.add(1);

    return {
      output: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: InvoiceStatus.OPEN,
        issuedAt: issuedAt.toISOString(),
        dueAt: dueAt.toISOString(),
        subtotalCents: invoice.subtotalCents,
        totalCents: invoice.totalCents,
        lineCount: invoice._count.lines,
        version: nextVersion,
        alreadyFinalized: false,
      },
      audit: {
        action: "billing.invoice.finalized",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          previousStatus: invoice.status,
          newStatus: InvoiceStatus.OPEN,
          subtotalCents: invoice.subtotalCents,
          totalCents: invoice.totalCents,
          lineCount: invoice._count.lines,
          daysUntilDue: input.daysUntilDue,
          issuedAt: issuedAt.toISOString(),
          dueAt: dueAt.toISOString(),
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "billing.invoice.finalized.v1",
          aggregateType: "Invoice",
          aggregateId: invoice.id,
          payload: {
            organizationId: ctx.organizationId,
            clinicId: invoice.clinicId,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            currency: invoice.currency,
            subtotalCents: invoice.subtotalCents,
            totalCents: invoice.totalCents,
            amountDueCents: invoice.amountDueCents,
            lineCount: invoice._count.lines,
            issuedAt: issuedAt.toISOString(),
            dueAt: dueAt.toISOString(),
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};

// Re-export the Prisma error type for handlers that need to discriminate
// on `P2025` etc; keeps callers from importing @pharmax/database directly.
export { Prisma };
