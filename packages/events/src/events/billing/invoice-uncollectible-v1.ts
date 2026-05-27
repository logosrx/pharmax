// billing.invoice.uncollectible.v1 — invoice written off as uncollectible.
//
// Producer: `MarkInvoiceUncollectible` (`@pharmax/billing`),
//   driven by Stripe's `invoice.marked_uncollectible` webhook
//   (or by an operator-initiated write-off in a future slice).
// Consumers: INVOICE_UNCOLLECTIBLE_V1 notification; aging report
//   exit; future accounting export.

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
     * Outstanding balance written off when the invoice moved
     * UNCOLLECTIBLE. Integer cents.
     */
    residualWriteOffCents: z.number().int().min(0),
    /** When Stripe marked the invoice uncollectible. */
    recordedAt: z.iso.datetime({ offset: true }),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingInvoiceUncollectibleV1 = defineEvent({
  name: "billing.invoice.uncollectible",
  version: 1,
  aggregateType: "Invoice",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.invoiceId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.invoice",
  description:
    "Emitted by MarkInvoiceUncollectible when Stripe (or an operator) writes off an invoice. Carries the residual balance — drives the internal write-off alert.",
});

export type BillingInvoiceUncollectibleV1Payload = z.infer<typeof payloadSchema>;
