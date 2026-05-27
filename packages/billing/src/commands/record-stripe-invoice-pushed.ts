// RecordStripeInvoicePushed — system command that writes the
// `stripeInvoiceId` linkage back to a Pharmax invoice after the
// worker successfully pushes it to Stripe.
//
// Split from `FinalizeInvoice` because:
//
//   - The Stripe SDK call is asynchronous and lives outside any
//     Pharmax transaction. A failure there should NOT roll back
//     the operator's finalize action.
//
//   - The push handler runs in the worker without a human actor;
//     a SystemCommand is the right shape (no permission gate, no
//     tenant-scoped role required).
//
//   - Idempotency: Stripe's own idempotency-key feature dedups
//     the push side; this command idempotently writes the linkage
//     (no-op if `stripeInvoiceId` is already set to the same value).
//
// PHI invariant: no PHI. The Stripe invoice id is an opaque
// identifier; nothing else is recorded.

import type { PrismaTxClient, SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { z } from "zod";

export const RECORD_STRIPE_PUSH_INVOICE_NOT_FOUND = "RECORD_STRIPE_PUSH_INVOICE_NOT_FOUND";
export const RECORD_STRIPE_PUSH_MISMATCH = "RECORD_STRIPE_PUSH_MISMATCH";

const inputSchema = z
  .object({
    organizationId: z.uuid(),
    invoiceId: z.uuid(),
    stripeInvoiceId: z.string().min(1).max(128),
    stripeCustomerId: z.string().min(1).max(128),
    /** Stripe's reported invoice status at the time of push. */
    stripeStatus: z.enum(["draft", "open", "paid", "uncollectible", "void"]),
    /** Hosted invoice URL (operator-facing). */
    hostedInvoiceUrl: z.string().url().optional(),
  })
  .strict();

export type RecordStripeInvoicePushedInput = z.infer<typeof inputSchema>;

export interface RecordStripeInvoicePushedOutput {
  readonly invoiceId: string;
  readonly stripeInvoiceId: string;
  /** True when this is the first push (linkage was previously null). */
  readonly firstLink: boolean;
}

async function loadInvoice(
  tx: PrismaTxClient,
  input: { organizationId: string; invoiceId: string }
): Promise<{ id: string; stripeInvoiceId: string | null } | null> {
  return await tx.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { id: true, stripeInvoiceId: true },
  });
}

export const RecordStripeInvoicePushed: SystemCommand<
  RecordStripeInvoicePushedInput,
  RecordStripeInvoicePushedOutput
> = {
  name: "RecordStripeInvoicePushed",
  inputSchema,

  async handle({
    input,
    tx,
    clock,
    commandLogId,
  }): Promise<SystemHandlerResult<RecordStripeInvoicePushedOutput>> {
    const invoice = await loadInvoice(tx, {
      organizationId: input.organizationId,
      invoiceId: input.invoiceId,
    });
    if (invoice === null) {
      throw new errors.NotFoundError({
        code: RECORD_STRIPE_PUSH_INVOICE_NOT_FOUND,
        message: "Invoice not found in the target organization.",
        metadata: { organizationId: input.organizationId, invoiceId: input.invoiceId },
      });
    }

    // ---- Already-linked branch ----
    if (invoice.stripeInvoiceId !== null) {
      if (invoice.stripeInvoiceId !== input.stripeInvoiceId) {
        // Two different Stripe invoices for one Pharmax invoice is
        // a serious bug — surface loudly. Most likely cause: the
        // push handler was retried after a Stripe-side dedupe-key
        // mismatch, which should be impossible if the
        // idempotency-key is anchored on the Pharmax invoice id.
        throw new errors.ConflictError({
          code: RECORD_STRIPE_PUSH_MISMATCH,
          message:
            "Pharmax invoice is already linked to a DIFFERENT Stripe invoice. Investigate before retrying.",
          metadata: {
            invoiceId: invoice.id,
            existingStripeInvoiceId: invoice.stripeInvoiceId,
            attemptedStripeInvoiceId: input.stripeInvoiceId,
          },
        });
      }
      const now = clock.now();
      return {
        output: {
          invoiceId: invoice.id,
          stripeInvoiceId: invoice.stripeInvoiceId,
          firstLink: false,
        },
        targetOrganizationId: input.organizationId,
        audit: {
          action: "billing.invoice.stripe_push.skipped",
          resourceType: "Invoice",
          resourceId: invoice.id,
          metadata: {
            invoiceId: invoice.id,
            stripeInvoiceId: invoice.stripeInvoiceId,
            reason: "already-linked",
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: [],
      };
    }

    // ---- First-link branch ----
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        stripeInvoiceId: input.stripeInvoiceId,
        stripeCustomerId: input.stripeCustomerId,
      },
    });

    const now = clock.now();
    return {
      output: {
        invoiceId: invoice.id,
        stripeInvoiceId: input.stripeInvoiceId,
        firstLink: true,
      },
      targetOrganizationId: input.organizationId,
      audit: {
        action: "billing.invoice.stripe_pushed",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          stripeInvoiceId: input.stripeInvoiceId,
          stripeCustomerId: input.stripeCustomerId,
          stripeStatus: input.stripeStatus,
          hostedInvoiceUrl: input.hostedInvoiceUrl ?? null,
          commandLogId,
          occurredAt: now.toISOString(),
        },
      },
      outboxEvents: [
        {
          eventType: "billing.invoice.stripe_pushed.v1",
          aggregateType: "Invoice",
          aggregateId: invoice.id,
          payload: {
            organizationId: input.organizationId,
            invoiceId: invoice.id,
            stripeInvoiceId: input.stripeInvoiceId,
            stripeCustomerId: input.stripeCustomerId,
            stripeStatus: input.stripeStatus,
            hostedInvoiceUrl: input.hostedInvoiceUrl ?? null,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
