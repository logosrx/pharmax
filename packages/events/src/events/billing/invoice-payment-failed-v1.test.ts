// Schema tests for billing.invoice.payment_failed.v1.

import { describe, expect, it } from "vitest";

import { validateAgainst } from "../../define-event.js";
import { BillingInvoicePaymentFailedV1 } from "./invoice-payment-failed-v1.js";

const HAPPY: Record<string, unknown> = Object.freeze({
  organizationId: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  invoiceId: "00000000-0000-4000-8000-000000000003",
  invoiceNumber: "INV-2026-0001",
  stripeInvoiceId: "in_test_abc",
  failureCode: "card_declined",
  attemptedAmountCents: 12500,
  nextAttemptAt: "2026-05-26T10:00:00.000Z",
  failedAt: "2026-05-25T10:00:00.000Z",
  occurredAt: "2026-05-25T10:00:00.000Z",
});

describe("BillingInvoicePaymentFailedV1 schema", () => {
  it("accepts a well-formed payload", () => {
    expect(validateAgainst(BillingInvoicePaymentFailedV1, HAPPY).ok).toBe(true);
  });

  it("accepts null failureCode (no structured reason)", () => {
    expect(validateAgainst(BillingInvoicePaymentFailedV1, { ...HAPPY, failureCode: null }).ok).toBe(
      true
    );
  });

  it("accepts null nextAttemptAt (no retry queued)", () => {
    expect(
      validateAgainst(BillingInvoicePaymentFailedV1, { ...HAPPY, nextAttemptAt: null }).ok
    ).toBe(true);
  });

  it("rejects negative attemptedAmountCents", () => {
    expect(
      validateAgainst(BillingInvoicePaymentFailedV1, { ...HAPPY, attemptedAmountCents: -1 }).ok
    ).toBe(false);
  });

  it("rejects extra (potentially PHI) fields under strict mode", () => {
    expect(
      validateAgainst(BillingInvoicePaymentFailedV1, {
        ...HAPPY,
        patientEmail: "test@example.com",
      }).ok
    ).toBe(false);
  });

  it("aggregateIdFrom selects invoiceId", () => {
    expect(BillingInvoicePaymentFailedV1.aggregateIdFrom(HAPPY as never)).toBe(HAPPY.invoiceId);
  });
});
