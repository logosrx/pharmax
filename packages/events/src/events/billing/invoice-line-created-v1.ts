// billing.invoice_line.created.v1 — a line was appended to an invoice.
//
// Producer: `MaterializeShippedOrderBilling` (`@pharmax/billing`)
//   when it turns `order.shipped.v1` into a dispense-fee line.
// Consumers: future invoice-totals projection, future operator
//   notification when an invoice exceeds a budget threshold.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const INVOICE_LINE_KINDS = [
  "DISPENSE_FEE",
  "SHIPPING_FEE",
  "RUSH_FEE",
  "PRODUCT",
  "CREDIT",
  "DISCOUNT",
  "ADJUSTMENT",
] as const;

const PRICING_SCHEMES = ["FLAT_V1", "RULE_V2"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    invoiceId: z.uuid(),
    invoiceLineId: z.uuid(),
    invoiceNumber: z.string().min(1).max(64),
    /**
     * Source order for traceability. Always set today (every line
     * is anchored to an order via `MaterializeShippedOrderBilling`);
     * stays required so consumers can rely on it.
     */
    orderId: z.uuid(),
    shipmentId: z.uuid(),
    kind: z.enum(INVOICE_LINE_KINDS),
    amountCents: z.number().int(),
    currency: z.string().min(3).max(3),
    pricingScheme: z.enum(PRICING_SCHEMES),
    /** Set when `pricingScheme === "RULE_V2"`; null for FLAT_V1. */
    pricingRuleId: z.uuid().nullable(),
    billingPeriodKey: z.string().regex(/^\d{4}-\d{2}$/),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingInvoiceLineCreatedV1 = defineEvent({
  name: "billing.invoice_line.created",
  version: 1,
  aggregateType: "Invoice",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.invoiceId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.invoice",
  description:
    "Emitted by MaterializeShippedOrderBilling when a dispense-fee line is appended to an open DRAFT invoice. Carries the pricing-scheme stamp so a future re-pricing job can find FLAT_V1 lines to backfill.",
});

export type BillingInvoiceLineCreatedV1Payload = z.infer<typeof payloadSchema>;
