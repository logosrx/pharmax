// MarkInvoiceVoided — system command invoked when Stripe fires
// `invoice.voided` for a Pharmax-linked invoice. Terminal status
// transition; cannot be reversed.
//
// Mirrors MarkInvoicePaid's shape (idempotency, orphan-tolerance,
// CAS) but is much simpler — no amount math, just a status flip
// with `voidedAt`.
//
// Operator semantics:
//
//   `invoice.voided` typically fires when an operator voids a Stripe
//   invoice from the Stripe dashboard, OR when our finalization
//   pushed a draft that was subsequently voided server-side. Either
//   way, the Pharmax row should reflect the new truth so downstream
//   collection / aging reports don't keep counting it.
//
// PHI invariant: none. Stripe ids only.

import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { InvoiceStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { z } from "zod";

export const MARK_VOIDED_VERSION_MISMATCH = "MARK_VOIDED_VERSION_MISMATCH";
export const MARK_VOIDED_INVALID_STATUS_TRANSITION = "MARK_VOIDED_INVALID_STATUS_TRANSITION";

const inputSchema = z
  .object({
    invoiceId: z.uuid(),
    organizationId: z.uuid(),
    stripeInvoiceId: z.string().min(1).max(128),
    voidedAt: z.iso.datetime({ offset: true }),
    stripeEventId: z.string().min(1).max(128),
  })
  .strict();

export type MarkInvoiceVoidedInput = z.infer<typeof inputSchema>;

export interface MarkInvoiceVoidedOutput {
  readonly invoiceId: string;
  readonly recognized: boolean;
  readonly transitioned: boolean;
  readonly status: InvoiceStatus;
  readonly version: number;
}

export const MarkInvoiceVoided: SystemCommand<MarkInvoiceVoidedInput, MarkInvoiceVoidedOutput> = {
  name: "MarkInvoiceVoided",
  inputSchema,

  async handle({
    input,
    tx,
    clock,
    commandLogId,
  }): Promise<SystemHandlerResult<MarkInvoiceVoidedOutput>> {
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, organizationId: input.organizationId },
      select: {
        id: true,
        organizationId: true,
        status: true,
        version: true,
        stripeInvoiceId: true,
        invoiceNumber: true,
        clinicId: true,
      },
    });

    const now = clock.now();

    // Orphan / not-found — soft miss.
    if (invoice === null) {
      return {
        output: {
          invoiceId: input.invoiceId,
          recognized: false,
          transitioned: false,
          status: InvoiceStatus.OPEN,
          version: 0,
        },
        targetOrganizationId: input.organizationId,
        audit: {
          action: "billing.invoice.stripe_voided.unrecognized",
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

    if (invoice.stripeInvoiceId !== null && invoice.stripeInvoiceId !== input.stripeInvoiceId) {
      throw new errors.ConflictError({
        code: "MARK_VOIDED_STRIPE_INVOICE_MISMATCH",
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

    // Already-VOID short-circuit (Stripe retries).
    if (invoice.status === InvoiceStatus.VOID) {
      return {
        output: {
          invoiceId: invoice.id,
          recognized: true,
          transitioned: false,
          status: invoice.status,
          version: invoice.version,
        },
        targetOrganizationId: invoice.organizationId,
        audit: {
          action: "billing.invoice.stripe_voided.skipped",
          resourceType: "Invoice",
          resourceId: invoice.id,
          metadata: {
            invoiceId: invoice.id,
            stripeInvoiceId: input.stripeInvoiceId,
            stripeEventId: input.stripeEventId,
            reason: "already-voided",
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: [],
      };
    }

    // PAID / UNCOLLECTIBLE → VOID is a Stripe ordering bug or
    // operator-initiated mistake; surface so an operator
    // investigates.
    if (invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.UNCOLLECTIBLE) {
      throw new errors.ConflictError({
        code: MARK_VOIDED_INVALID_STATUS_TRANSITION,
        message: `Cannot void invoice from terminal status ${invoice.status}.`,
        metadata: {
          invoiceId: invoice.id,
          currentStatus: invoice.status,
          stripeInvoiceId: input.stripeInvoiceId,
          stripeEventId: input.stripeEventId,
        },
      });
    }

    const voidedAtDate = new Date(input.voidedAt);
    const nextVersion = invoice.version + 1;
    const updated = await tx.invoice.updateMany({
      where: { id: invoice.id, version: invoice.version },
      data: {
        status: InvoiceStatus.VOID,
        voidedAt: voidedAtDate,
        // amountDue → 0 on void: a voided invoice has no
        // collectability, and the aging report excludes VOID
        // rows anyway. Keep totals untouched for audit history.
        amountDueCents: 0,
        version: nextVersion,
        ...(invoice.stripeInvoiceId === null ? { stripeInvoiceId: input.stripeInvoiceId } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new errors.ConflictError({
        code: MARK_VOIDED_VERSION_MISMATCH,
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
        status: InvoiceStatus.VOID,
        version: nextVersion,
      },
      targetOrganizationId: invoice.organizationId,
      audit: {
        action: "billing.invoice.stripe_voided",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          stripeInvoiceId: input.stripeInvoiceId,
          stripeEventId: input.stripeEventId,
          voidedAt: voidedAtDate.toISOString(),
          previousStatus: invoice.status,
          newStatus: InvoiceStatus.VOID,
          commandLogId,
          occurredAt: now.toISOString(),
        },
      },
      outboxEvents: [
        {
          eventType: "billing.invoice.voided.v1",
          aggregateType: "Invoice",
          aggregateId: invoice.id,
          payload: {
            organizationId: invoice.organizationId,
            clinicId: invoice.clinicId,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            stripeInvoiceId: input.stripeInvoiceId,
            voidedAt: voidedAtDate.toISOString(),
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
