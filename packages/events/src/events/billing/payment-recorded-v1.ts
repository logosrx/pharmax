// billing.payment.recorded.v1 — a settled money movement (payment
// or refund) was appended to the payment ledger.
//
// Producers (all in `@pharmax/billing`):
//   - `MarkInvoicePaid` — PAYMENT row when Stripe's `invoice.paid`
//     webhook settles an invoice.
//   - `IssueRefund` — REFUND row when the operator-initiated Stripe
//     refund returns `succeeded` synchronously.
//   - `RecordRefundReceived` — REFUND row for out-of-band refunds,
//     and the settle-time row for refunds that were `pending` when
//     IssueRefund wrote the invoice line.
//   - `RecordManualPayment` — PAYMENT row (method MANUAL) for
//     operator-recorded checks / ACH / wires / cash.
//   - `ApplyClinicCredit` — PAYMENT row (method CREDIT_BALANCE) when
//     stored clinic credit settles an invoice. NOTE: no new cash
//     arrives on these — the cash moved when the credit was granted.
//
// Only SETTLED movements are announced — a consumer can treat this
// stream as "money actually moved". Failed attempts and pending
// refunds never produce this event.
//
// Consumers: future payment-activity feed, reconciliation exports,
// clinic payment-received notifications.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    invoiceId: z.uuid(),
    paymentId: z.uuid(),
    kind: z.enum(["PAYMENT", "REFUND"]),
    method: z.enum(["STRIPE", "MANUAL", "CREDIT_BALANCE"]),
    /** Always positive; direction comes from `kind`. */
    amountCents: z.number().int().min(1),
    currency: z.string().min(3).max(3),
    /** Idempotency anchor of the ledger row (e.g. "stripe-paid:{eventId}"). */
    paymentEventKey: z.string().min(1).max(256),
    /** When the money actually moved (Stripe's timestamp). */
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingPaymentRecordedV1 = defineEvent({
  name: "billing.payment.recorded",
  version: 1,
  aggregateType: "Invoice",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.invoiceId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.invoice",
  description:
    "Emitted when a settled payment or refund is appended to the payment ledger. Only settled money movements are announced; amounts are always positive with direction in kind.",
});

export type BillingPaymentRecordedV1Payload = z.infer<typeof payloadSchema>;
