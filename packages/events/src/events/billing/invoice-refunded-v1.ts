// billing.invoice.refunded.v1 — full or partial refund issued.
//
// Producers:
//   - `IssueRefund` (`@pharmax/billing`) — operator-driven refund;
//     Stripe charge is refunded via the configured Stripe port.
//   - `RecordRefundReceived` system command — driven by the Stripe
//     `charge.refunded` webhook when the refund completes
//     asynchronously.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    invoiceId: z.uuid(),
    /** Nullable when the producer is the webhook path (no internal line was created). */
    invoiceLineId: z.uuid().nullable(),
    stripeRefundId: z.string().min(1).max(64),
    stripeStatus: z.string().min(1).max(32),
    /** Nullable when the refund came in via webhook without a paired charge id. */
    stripeChargeId: z.string().min(1).max(64).nullable(),
    reason: z.string().min(1).max(64),
    amountCents: z.number().int().min(0),
    amountDueCentsAfter: z.number().int(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingInvoiceRefundedV1 = defineEvent({
  name: "billing.invoice.refunded",
  version: 1,
  aggregateType: "Invoice",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.invoiceId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.invoice",
  description:
    "Emitted by IssueRefund and RecordRefundReceived. Same shape on both paths; the producer is captured in audit metadata, not the payload.",
});

export type BillingInvoiceRefundedV1Payload = z.infer<typeof payloadSchema>;
