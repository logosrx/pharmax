// billing.invoice.paid.v1 — invoice reached PAID.
//
// Producers:
//   - `MarkInvoicePaid` system command (`@pharmax/billing`), driven
//     by the `invoice.paid` Stripe webhook.
//   - `RecordManualPayment` tenant command, when an out-of-band
//     payment (check / ACH / wire / cash) collects the full balance.
// Consumers: ops dashboard / clinic-portal payment status; future
//   accounting export.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    invoiceId: z.uuid(),
    invoiceNumber: z.string().min(1).max(64),
    /** Nullable: manual (check/ACH/wire) settles have no Stripe invoice. */
    stripeInvoiceId: z.string().min(1).max(64).nullable(),
    /** Nullable: Stripe may pay an invoice from a credit balance without a charge; always null for manual settles. */
    stripeChargeId: z.string().min(1).max(64).nullable(),
    amountPaidCents: z.number().int().min(0),
    totalCents: z.number().int().min(0),
    paidAt: z.iso.datetime({ offset: true }),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingInvoicePaidV1 = defineEvent({
  name: "billing.invoice.paid",
  version: 1,
  aggregateType: "Invoice",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.invoiceId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.invoice",
  description:
    "Emitted when an invoice reaches PAID — by MarkInvoicePaid (Stripe invoice.paid webhook) or RecordManualPayment (out-of-band check/ACH/wire settle). Drives clinic-portal status, aging exit, and downstream accounting projections.",
});

export type BillingInvoicePaidV1Payload = z.infer<typeof payloadSchema>;
