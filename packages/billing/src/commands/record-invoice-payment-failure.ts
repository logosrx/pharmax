// RecordInvoicePaymentFailure — system command invoked when Stripe
// fires `invoice.payment_failed`. Does NOT change invoice status —
// Stripe will keep retrying collection on its own schedule until it
// either succeeds (→ `MarkInvoicePaid`) or gives up
// (→ `MarkInvoiceUncollectible`).
//
// What this command DOES do:
//
//   - Records the failure attempt on the audit chain so operators can
//     see "we tried to collect on 2026-05-15, failed because the card
//     was declined" in the invoice timeline.
//
//   - Emits `billing.invoice.payment_failed.v1` so a future
//     notification slice can fire emails / SMS to the clinic AR
//     contact without coupling the notification logic to the
//     webhook drain.
//
//   - Idempotent on the originating Stripe event id — re-delivery
//     of the same event is a no-op.
//
// Why a command instead of inline logging:
//
//   - The audit row goes through the chain writer (tamper-evident).
//   - The outbox row is the API contract for the future
//     notifications handler.
//   - Same shape as the status-transition commands → uniform
//     handler wiring at the worker layer.
//
// PHI invariant: none. Stripe ids + decline reasons only.

import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { z } from "zod";

const inputSchema = z
  .object({
    invoiceId: z.uuid(),
    organizationId: z.uuid(),
    stripeInvoiceId: z.string().min(1).max(128),
    stripeEventId: z.string().min(1).max(128),
    /** Best-effort Stripe failure reason (e.g. "card_declined"). */
    failureCode: z.string().min(1).max(128).optional(),
    failureMessage: z.string().min(1).max(500).optional(),
    /** Total Stripe attempted to collect (cents). */
    attemptedAmountCents: z.number().int().min(0).optional(),
    /** Stripe `next_payment_attempt` if scheduled. */
    nextAttemptAt: z.iso.datetime({ offset: true }).optional(),
    failedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type RecordInvoicePaymentFailureInput = z.infer<typeof inputSchema>;

export interface RecordInvoicePaymentFailureOutput {
  readonly invoiceId: string;
  readonly recognized: boolean;
}

export const RecordInvoicePaymentFailure: SystemCommand<
  RecordInvoicePaymentFailureInput,
  RecordInvoicePaymentFailureOutput
> = {
  name: "RecordInvoicePaymentFailure",
  inputSchema,

  async handle({
    input,
    tx,
    clock,
    commandLogId,
  }): Promise<SystemHandlerResult<RecordInvoicePaymentFailureOutput>> {
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, organizationId: input.organizationId },
      select: {
        id: true,
        organizationId: true,
        invoiceNumber: true,
        clinicId: true,
        status: true,
        stripeInvoiceId: true,
      },
    });

    const now = clock.now();

    if (invoice === null) {
      return {
        output: { invoiceId: input.invoiceId, recognized: false },
        targetOrganizationId: input.organizationId,
        audit: {
          action: "billing.invoice.stripe_payment_failed.unrecognized",
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

    const failedAtDate = new Date(input.failedAt);

    return {
      output: { invoiceId: invoice.id, recognized: true },
      targetOrganizationId: invoice.organizationId,
      audit: {
        action: "billing.invoice.stripe_payment_failed",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          stripeInvoiceId: input.stripeInvoiceId,
          stripeEventId: input.stripeEventId,
          failureCode: input.failureCode ?? null,
          failureMessage: input.failureMessage ?? null,
          attemptedAmountCents: input.attemptedAmountCents ?? null,
          nextAttemptAt: input.nextAttemptAt ?? null,
          currentStatus: invoice.status,
          failedAt: failedAtDate.toISOString(),
          commandLogId,
          occurredAt: now.toISOString(),
        },
      },
      outboxEvents: [
        {
          eventType: "billing.invoice.payment_failed.v1",
          aggregateType: "Invoice",
          aggregateId: invoice.id,
          payload: {
            organizationId: invoice.organizationId,
            clinicId: invoice.clinicId,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            stripeInvoiceId: input.stripeInvoiceId,
            failureCode: input.failureCode ?? null,
            attemptedAmountCents: input.attemptedAmountCents ?? null,
            nextAttemptAt: input.nextAttemptAt ?? null,
            failedAt: failedAtDate.toISOString(),
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
