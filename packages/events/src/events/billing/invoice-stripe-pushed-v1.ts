// billing.invoice.stripe_pushed.v1 — invoice push to Stripe succeeded.
//
// Producer: `RecordStripeInvoicePushed` system command
//   (`@pharmax/billing`) — written back by the push-to-stripe worker
//   handler after a successful Stripe Invoice API call.
// Consumers: read-side projections that display "open in Stripe"
//   links, reconciliation that watches for `paid` webhooks.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    invoiceId: z.uuid(),
    stripeInvoiceId: z.string().min(1).max(64),
    stripeCustomerId: z.string().min(1).max(64),
    stripeStatus: z.string().min(1).max(32),
    hostedInvoiceUrl: z.string().url().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingInvoiceStripePushedV1 = defineEvent({
  name: "billing.invoice.stripe_pushed",
  version: 1,
  aggregateType: "Invoice",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.invoiceId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.invoice",
  description:
    "Emitted by RecordStripeInvoicePushed after the Stripe Invoice API call succeeds. Pairs the internal invoice id with the external Stripe ids for reconciliation.",
});

export type BillingInvoiceStripePushedV1Payload = z.infer<typeof payloadSchema>;
