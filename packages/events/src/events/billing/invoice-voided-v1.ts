// billing.invoice.voided.v1 — invoice was voided (Stripe-side).
//
// Producer: `MarkInvoiceVoided` (`@pharmax/billing`), driven by
//   the Stripe `invoice.voided` webhook.
// Consumers: clinic-portal invoice status; aging report exit;
//   future accounting export.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    invoiceId: z.uuid(),
    invoiceNumber: z.string().min(1).max(64),
    stripeInvoiceId: z.string().min(1).max(64),
    voidedAt: z.iso.datetime({ offset: true }),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingInvoiceVoidedV1 = defineEvent({
  name: "billing.invoice.voided",
  version: 1,
  aggregateType: "Invoice",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.invoiceId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.invoice",
  description:
    "Emitted by MarkInvoiceVoided when the Stripe invoice.voided webhook fires. Marks the invoice terminal in the clinic-portal status feed and exits it from the aging report.",
});

export type BillingInvoiceVoidedV1Payload = z.infer<typeof payloadSchema>;
