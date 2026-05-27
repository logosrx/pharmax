// billing.invoice.credited.v1 — operator applied a credit / discount / adjustment.
//
// Producer: `CreditInvoice` (`@pharmax/billing`).
// Consumers: clinic-portal balance, future credit-history report.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const CREDIT_KINDS = ["CREDIT", "DISCOUNT", "ADJUSTMENT"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    invoiceId: z.uuid(),
    invoiceLineId: z.uuid(),
    kind: z.enum(CREDIT_KINDS),
    /** Negative-cents value as it appears on the credit line. */
    creditAmountCents: z.number().int(),
    subtotalCentsAfter: z.number().int(),
    totalCentsAfter: z.number().int(),
    amountDueCentsAfter: z.number().int(),
    /**
     * True when the operator left a free-text reason. The text
     * itself stays out of the payload (it may carry PHI by
     * accident); consumers that need it read from the
     * `invoice_line.metadata` row.
     */
    hasReasonText: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingInvoiceCreditedV1 = defineEvent({
  name: "billing.invoice.credited",
  version: 1,
  aggregateType: "Invoice",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.invoiceId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.invoice",
  description:
    "Emitted by CreditInvoice. Carries the post-credit invoice totals so consumers don't need to re-read the invoice row to update displays.",
});

export type BillingInvoiceCreditedV1Payload = z.infer<typeof payloadSchema>;
