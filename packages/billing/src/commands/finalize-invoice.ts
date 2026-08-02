// FinalizeInvoice — DRAFT → OPEN transition for a billing-period
// invoice, locking it for further line appends and triggering the
// downstream Stripe push pipeline.
//
// Lifecycle:
//
//   DRAFT (accepts new lines)
//     → ApproveInvoice   (review gate — required first)
//   DRAFT + approval stamp
//     → FinalizeInvoice
//   OPEN  (no new lines; awaiting Stripe push + collection)
//     → (worker) push to Stripe → write stripeInvoiceId
//     → (Stripe) payment → webhook → status flips PAID
//
// Approval requirement:
//
//   - Finalization requires a FRESH approval: `approvedAt` set AND
//     `approvedVersion === version`. The materializer bumps `version`
//     on every line append, so a late shipped-order line landing
//     after the review structurally invalidates the approval —
//     `FINALIZE_INVOICE_APPROVAL_STALE` — and the reviewer looks at
//     the new total before anything reaches Stripe.
//   - `billing.approve_invoice` and `billing.finalize_invoice` are
//     distinct permissions, so orgs can split reviewer and finalizer
//     across roles (segregation of duties). Auto-finalize (the
//     period-boundary cron slice) will finalize APPROVED drafts only,
//     so the human review stays load-bearing under automation.
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

import {
  assertReadyToFinalize,
  FINALIZE_INVOICE_APPROVAL_STALE,
  FINALIZE_INVOICE_EMPTY,
  FINALIZE_INVOICE_NOT_APPROVED,
  FINALIZE_INVOICE_NOT_FOUND,
  FINALIZE_INVOICE_VERSION_MISMATCH,
  invoiceFinalizedOutboxEvent,
  loadInvoiceForFinalize,
  performFinalizeCas,
} from "../finalize-invoice-core.js";

// The guards, CAS, and outbox shape live in `finalize-invoice-core.ts`,
// shared with the period-boundary cron's `AutoFinalizeDueInvoice`.
// Error codes are re-exported here — this module remains the public
// API path for them.
export {
  FINALIZE_INVOICE_APPROVAL_STALE,
  FINALIZE_INVOICE_EMPTY,
  FINALIZE_INVOICE_NOT_APPROVED,
  FINALIZE_INVOICE_NOT_FOUND,
  FINALIZE_INVOICE_VERSION_MISMATCH,
};

const meter = getMeter("@pharmax/billing");

const billingInvoiceFinalizedCounter = meter.createCounter(
  "pharmax_billing_invoice_finalized_total",
  {
    description:
      "Invoices transitioned DRAFT → OPEN via FinalizeInvoice. Idempotent re-finalizations (alreadyFinalized=true) are NOT counted.",
  }
);

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
    const invoice = await loadInvoiceForFinalize(tx, {
      invoiceId: input.invoiceId,
      organizationId: ctx.organizationId,
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
          lineCount: invoice.lineCount,
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

    // ---- Guards (empty / not-approved / stale) + CAS ----
    // Both live in `finalize-invoice-core.ts`, shared verbatim with
    // the period-boundary cron. Typed failures propagate unchanged.
    assertReadyToFinalize(invoice);

    const now = clock.now();
    const cas = await performFinalizeCas(tx, {
      invoice,
      daysUntilDue: input.daysUntilDue,
      now,
    });
    const { issuedAt, dueAt, nextVersion } = cas;

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
        lineCount: invoice.lineCount,
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
          lineCount: invoice.lineCount,
          daysUntilDue: input.daysUntilDue,
          issuedAt: issuedAt.toISOString(),
          dueAt: dueAt.toISOString(),
          // The approval this finalization consumed — auditors read
          // "who reviewed, which revision" from the same row.
          approvedByUserId: invoice.approvedByUserId,
          approvedVersion: invoice.approvedVersion,
          approvedAt: invoice.approvedAt?.toISOString() ?? null,
          commandLogId,
        },
      },
      outboxEvents: [
        invoiceFinalizedOutboxEvent({
          organizationId: ctx.organizationId,
          invoice,
          cas,
          occurredAt: now,
        }),
      ],
    };
  },
};

// Re-export the Prisma error type for handlers that need to discriminate
// on `P2025` etc; keeps callers from importing @pharmax/database directly.
export { Prisma };
