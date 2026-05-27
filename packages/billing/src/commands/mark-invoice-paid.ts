// MarkInvoicePaid — system command invoked by the Stripe webhook
// drain when `invoice.paid` fires for a Pharmax-linked invoice.
//
// Pipeline:
//
//   Stripe webhook → apps/web /api/webhooks/stripe records the row →
//   apps/worker drain claims it → dispatcher routes `invoice.paid` →
//   stripe-handler resolves the Pharmax invoice by stripeInvoiceId →
//   THIS COMMAND flips status OPEN → PAID, records amount + paidAt,
//   emits `billing.invoice.paid.v1`.
//
// Idempotency:
//
//   - The Stripe webhook drain enforces at-most-once dispatch via the
//     `stripe_webhook_event` table's unique constraint on
//     `externalEventId`. Re-delivery from Stripe never reaches this
//     command twice.
//   - The handler also short-circuits on an already-PAID invoice
//     (logs the no-op, no version bump, no outbox emit). This is the
//     second line of defense — supports manual retries via the
//     replay tool without re-emitting downstream side effects.
//   - If the lookup `stripeInvoiceId` resolves to nothing (orphan
//     event — Stripe invoice created by a different system or a
//     pre-linkage push), the handler returns cleanly with
//     `recognized: false`. This is NOT an error; surface as info.
//
// Concurrency:
//
//   - We CAS on `version` to detect a concurrent mutation (e.g. an
//     operator credit applied after the webhook fired). Mismatch
//     surfaces as `MARK_PAID_VERSION_MISMATCH`; the drain's retry
//     policy backs off and re-attempts once the racer commits.
//
// PHI invariant: nothing PHI is read or written. Stripe ids +
// amounts are non-PHI.

import type { PrismaTxClient, SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { InvoiceStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { z } from "zod";

export const MARK_PAID_VERSION_MISMATCH = "MARK_PAID_VERSION_MISMATCH";
export const MARK_PAID_INVALID_STATUS_TRANSITION = "MARK_PAID_INVALID_STATUS_TRANSITION";

const inputSchema = z
  .object({
    /**
     * The Pharmax invoice id. Resolved by the handler from the
     * incoming `stripeInvoiceId` via a system-context lookup.
     */
    invoiceId: z.uuid(),
    /**
     * Recorded for cross-org defense; the handler must verify the
     * invoice belongs to this org before dispatching.
     */
    organizationId: z.uuid(),
    /** The Stripe invoice id we're linking against. */
    stripeInvoiceId: z.string().min(1).max(128),
    /** Amount Stripe collected, in cents. May be less than `totalCents` for partial payments. */
    amountPaidCents: z.number().int().min(0),
    /** ISO timestamp from Stripe's `status_transitions.paid_at`. */
    paidAt: z.iso.datetime({ offset: true }),
    /** Originating Stripe event id (for audit traceability). */
    stripeEventId: z.string().min(1).max(128),
    /** Latest charge id, when present. Useful for refund traceability. */
    stripeChargeId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type MarkInvoicePaidInput = z.infer<typeof inputSchema>;

export interface MarkInvoicePaidOutput {
  readonly invoiceId: string;
  readonly recognized: boolean;
  /** True when this call performed the OPEN → PAID transition. */
  readonly transitioned: boolean;
  readonly status: InvoiceStatus;
  readonly amountPaidCents: number;
  readonly version: number;
}

async function loadInvoice(
  tx: PrismaTxClient,
  input: { organizationId: string; invoiceId: string }
): Promise<{
  id: string;
  organizationId: string;
  status: InvoiceStatus;
  totalCents: number;
  amountPaidCents: number;
  version: number;
  stripeInvoiceId: string | null;
  invoiceNumber: string;
  clinicId: string;
} | null> {
  return await tx.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      totalCents: true,
      amountPaidCents: true,
      version: true,
      stripeInvoiceId: true,
      invoiceNumber: true,
      clinicId: true,
    },
  });
}

export const MarkInvoicePaid: SystemCommand<MarkInvoicePaidInput, MarkInvoicePaidOutput> = {
  name: "MarkInvoicePaid",
  inputSchema,

  async handle({
    input,
    tx,
    clock,
    commandLogId,
  }): Promise<SystemHandlerResult<MarkInvoicePaidOutput>> {
    const invoice = await loadInvoice(tx, {
      organizationId: input.organizationId,
      invoiceId: input.invoiceId,
    });

    // ---- Orphan / unrecognized invoice ----
    // The handler resolved a Pharmax invoice id from the
    // stripeInvoiceId BEFORE calling us; a `null` here means the
    // row was deleted between resolve and dispatch (extremely
    // unlikely; invoices are RESTRICT-on-delete). Treat as a soft
    // miss so the drain doesn't retry forever.
    if (invoice === null) {
      const now = clock.now();
      return {
        output: {
          invoiceId: input.invoiceId,
          recognized: false,
          transitioned: false,
          status: InvoiceStatus.OPEN,
          amountPaidCents: 0,
          version: 0,
        },
        targetOrganizationId: input.organizationId,
        audit: {
          action: "billing.invoice.stripe_paid.unrecognized",
          resourceType: "Invoice",
          resourceId: input.invoiceId,
          metadata: {
            invoiceId: input.invoiceId,
            stripeInvoiceId: input.stripeInvoiceId,
            stripeEventId: input.stripeEventId,
            reason: "invoice-not-found",
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: [],
      };
    }

    // ---- Stripe-invoice-id sanity check ----
    // If the Pharmax row's `stripeInvoiceId` doesn't match what
    // Stripe just sent, something is structurally wrong (the
    // invoice was linked to a DIFFERENT Stripe invoice). Surface
    // as a typed conflict so an operator investigates.
    if (invoice.stripeInvoiceId !== null && invoice.stripeInvoiceId !== input.stripeInvoiceId) {
      throw new errors.ConflictError({
        code: "MARK_PAID_STRIPE_INVOICE_MISMATCH",
        message:
          "Pharmax invoice is linked to a DIFFERENT Stripe invoice than the inbound webhook. Investigate before retrying.",
        metadata: {
          invoiceId: invoice.id,
          existingStripeInvoiceId: invoice.stripeInvoiceId,
          inboundStripeInvoiceId: input.stripeInvoiceId,
          stripeEventId: input.stripeEventId,
        },
      });
    }

    const paidAtDate = new Date(input.paidAt);
    const now = clock.now();

    // ---- Already-paid short-circuit ----
    // PAID is a terminal status. Stripe may redeliver the
    // `invoice.paid` event after a replay; we MUST NOT bump the
    // version or re-emit the outbox row (would double-count any
    // downstream sync). VOID / UNCOLLECTIBLE → still no-op, but
    // we log loudly because PAID arriving after VOID is a Stripe
    // ordering bug worth investigating.
    if (invoice.status === InvoiceStatus.PAID) {
      return {
        output: {
          invoiceId: invoice.id,
          recognized: true,
          transitioned: false,
          status: invoice.status,
          amountPaidCents: invoice.amountPaidCents,
          version: invoice.version,
        },
        targetOrganizationId: invoice.organizationId,
        audit: {
          action: "billing.invoice.stripe_paid.skipped",
          resourceType: "Invoice",
          resourceId: invoice.id,
          metadata: {
            invoiceId: invoice.id,
            stripeInvoiceId: input.stripeInvoiceId,
            stripeEventId: input.stripeEventId,
            reason: "already-paid",
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: [],
      };
    }
    if (invoice.status === InvoiceStatus.VOID || invoice.status === InvoiceStatus.UNCOLLECTIBLE) {
      throw new errors.ConflictError({
        code: MARK_PAID_INVALID_STATUS_TRANSITION,
        message: `Cannot mark invoice PAID from terminal status ${invoice.status}. Stripe ordering issue — investigate event timeline.`,
        metadata: {
          invoiceId: invoice.id,
          currentStatus: invoice.status,
          stripeInvoiceId: input.stripeInvoiceId,
          stripeEventId: input.stripeEventId,
        },
      });
    }

    // ---- CAS update ----
    // OPEN → PAID with version bump. updateMany returns count=1
    // on hit, count=0 on concurrent mutation.
    const nextVersion = invoice.version + 1;
    const updated = await tx.invoice.updateMany({
      where: { id: invoice.id, version: invoice.version },
      data: {
        status: InvoiceStatus.PAID,
        paidAt: paidAtDate,
        amountPaidCents: input.amountPaidCents,
        // Reduce amountDue by the amount Stripe collected. Stripe
        // may collect partial amounts (e.g. coupon-applied invoices);
        // we honor whatever they report and leave any residual on
        // amountDue for downstream investigation.
        amountDueCents: Math.max(0, invoice.totalCents - input.amountPaidCents),
        version: nextVersion,
        // Also link stripeInvoiceId if not already set (defense in
        // depth — RecordStripeInvoicePushed should have set it,
        // but webhook can arrive first in race conditions).
        ...(invoice.stripeInvoiceId === null ? { stripeInvoiceId: input.stripeInvoiceId } : {}),
        // Capture the latest_charge id so future operator-driven
        // refunds (`IssueRefund`) can reach Stripe without an
        // extra lookup. Unique-when-present on the column means
        // a charge collision would surface at insert time.
        ...(input.stripeChargeId !== undefined ? { stripeChargeId: input.stripeChargeId } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new errors.ConflictError({
        code: MARK_PAID_VERSION_MISMATCH,
        message:
          "Invoice version was bumped by a concurrent mutation. Drain will retry once the racer commits.",
        metadata: { invoiceId: invoice.id, attemptedVersion: invoice.version },
      });
    }

    return {
      output: {
        invoiceId: invoice.id,
        recognized: true,
        transitioned: true,
        status: InvoiceStatus.PAID,
        amountPaidCents: input.amountPaidCents,
        version: nextVersion,
      },
      targetOrganizationId: invoice.organizationId,
      audit: {
        action: "billing.invoice.stripe_paid",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          stripeInvoiceId: input.stripeInvoiceId,
          stripeEventId: input.stripeEventId,
          stripeChargeId: input.stripeChargeId ?? null,
          amountPaidCents: input.amountPaidCents,
          totalCents: invoice.totalCents,
          residualDueCents: Math.max(0, invoice.totalCents - input.amountPaidCents),
          paidAt: paidAtDate.toISOString(),
          previousStatus: invoice.status,
          newStatus: InvoiceStatus.PAID,
          commandLogId,
          occurredAt: now.toISOString(),
        },
      },
      outboxEvents: [
        {
          eventType: "billing.invoice.paid.v1",
          aggregateType: "Invoice",
          aggregateId: invoice.id,
          payload: {
            organizationId: invoice.organizationId,
            clinicId: invoice.clinicId,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            stripeInvoiceId: input.stripeInvoiceId,
            stripeChargeId: input.stripeChargeId ?? null,
            amountPaidCents: input.amountPaidCents,
            totalCents: invoice.totalCents,
            paidAt: paidAtDate.toISOString(),
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
