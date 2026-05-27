// billing.invoice.finalized.v1 — invoice moved DRAFT → OPEN.
//
// Producer: `FinalizeInvoice` (`@pharmax/billing`).
// Consumer: `push-invoice-to-stripe` outbox handler
//   (`apps/worker/src/drains/`) — pushes the invoice to Stripe and
//   then writes back the stripe id via `RecordStripeInvoicePushed`.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    invoiceId: z.uuid(),
    invoiceNumber: z.string().min(1).max(64),
    currency: z.string().min(3).max(3),
    subtotalCents: z.number().int().min(0),
    totalCents: z.number().int().min(0),
    amountDueCents: z.number().int(),
    lineCount: z.number().int().min(1),
    issuedAt: z.iso.datetime({ offset: true }),
    dueAt: z.iso.datetime({ offset: true }),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingInvoiceFinalizedV1 = defineEvent({
  name: "billing.invoice.finalized",
  version: 1,
  aggregateType: "Invoice",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.invoiceId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.invoice",
  description:
    "Emitted by FinalizeInvoice. The Stripe push handler subscribes; one-shot semantics enforced by the bus idempotency cache and by the worker's per-row claim lease.",
});

export type BillingInvoiceFinalizedV1Payload = z.infer<typeof payloadSchema>;
