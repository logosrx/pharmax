// billing.invoice.payment_failed.v1 — a Stripe payment attempt failed.
//
// Producer: `RecordInvoicePaymentFailure` (`@pharmax/billing`),
//   driven by the Stripe `invoice.payment_failed` webhook.
// Consumers: future AR-contact notification handler; aging report
//   "at risk" view; reconciliation dashboard.
//
// PHI: none. Stripe ids + decline reason codes only — no card
// numbers, no patient data.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    invoiceId: z.uuid(),
    invoiceNumber: z.string().min(1).max(64),
    stripeInvoiceId: z.string().min(1).max(64),
    /**
     * Stripe decline-reason code (e.g. `card_declined`,
     * `insufficient_funds`). Null when the webhook payload did
     * not surface a structured code.
     */
    failureCode: z.string().min(1).max(64).nullable(),
    /** Amount Stripe attempted to charge, in integer cents. */
    attemptedAmountCents: z.number().int().min(0).nullable(),
    /** Scheduled next attempt timestamp; null when no retry queued. */
    nextAttemptAt: z.iso.datetime({ offset: true }).nullable(),
    failedAt: z.iso.datetime({ offset: true }),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingInvoicePaymentFailedV1 = defineEvent({
  name: "billing.invoice.payment_failed",
  version: 1,
  aggregateType: "Invoice",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.invoiceId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.invoice",
  description:
    "Emitted by RecordInvoicePaymentFailure when a Stripe payment attempt fails. Drives the AR-contact notification + the aging report's at-risk view.",
});

export type BillingInvoicePaymentFailedV1Payload = z.infer<typeof payloadSchema>;
