// Backfill-payment-ledger planning tests.
//
// The DB-touching plumbing (candidate collection, insertion) rides
// `insertPaymentLedgerRow` — covered in
// `packages/billing/src/payments/payment-ledger.test.ts`. These
// tests pin the PURE planning layer: key shapes, sign handling,
// timestamp fallbacks, the pending-refund skip, and CLI parsing.

import { describe, expect, it } from "vitest";

import {
  BACKFILL_METADATA_SOURCE,
  BACKFILL_PAID_KEY_PREFIX,
  type PaidInvoiceCandidate,
  parseCli,
  planPaymentBackfillRow,
  planRefundBackfillRow,
  type RefundLineCandidate,
} from "./backfill-payment-ledger.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";

const paidInvoice = (overrides: Partial<PaidInvoiceCandidate> = {}): PaidInvoiceCandidate => ({
  id: INVOICE_ID,
  organizationId: ORG_ID,
  clinicId: CLINIC_ID,
  currency: "usd",
  amountPaidCents: 15000,
  paidAt: new Date("2026-03-10T12:00:00.000Z"),
  updatedAt: new Date("2026-03-11T08:00:00.000Z"),
  stripeChargeId: "ch_Hist1",
  stripeInvoiceId: "in_Hist1",
  ...overrides,
});

describe("planPaymentBackfillRow", () => {
  it("keys on backfill-paid:{invoiceId} and anchors occurredAt on paidAt", () => {
    const row = planPaymentBackfillRow(paidInvoice());

    expect(row.paymentEventKey).toBe(`${BACKFILL_PAID_KEY_PREFIX}${INVOICE_ID}`);
    expect(row.kind).toBe("PAYMENT");
    expect(row.method).toBe("STRIPE");
    expect(row.amountCents).toBe(15000);
    expect(row.currency).toBe("usd");
    expect(row.stripeChargeId).toBe("ch_Hist1");
    expect(row.occurredAt.toISOString()).toBe("2026-03-10T12:00:00.000Z");
    expect(row.metadata).toEqual({
      source: BACKFILL_METADATA_SOURCE,
      stripeInvoiceId: "in_Hist1",
    });
  });

  it("falls back to updatedAt when paidAt is null (pre-MarkInvoicePaid rows)", () => {
    const row = planPaymentBackfillRow(paidInvoice({ paidAt: null }));
    expect(row.occurredAt.toISOString()).toBe("2026-03-11T08:00:00.000Z");
  });

  it("omits stripeChargeId when the invoice has none", () => {
    const row = planPaymentBackfillRow(paidInvoice({ stripeChargeId: null }));
    expect("stripeChargeId" in row).toBe(false);
  });
});

const refundLine = (overrides: Partial<RefundLineCandidate> = {}): RefundLineCandidate => ({
  id: "line-refund-1",
  invoiceId: INVOICE_ID,
  organizationId: ORG_ID,
  clinicId: CLINIC_ID,
  amountCents: -5000,
  billingEventKey: "stripe-refund:re_Hist1",
  metadata: {
    sourceEvent: "stripe-webhook-charge-refunded",
    stripeStatus: "succeeded",
    stripeChargeId: "ch_Hist1",
    stripeEventId: "evt_Hist1",
    refundedAt: "2026-04-01T09:30:00.000Z",
  },
  createdAt: new Date("2026-04-01T09:31:00.000Z"),
  invoiceCurrency: "usd",
  ...overrides,
});

describe("planRefundBackfillRow", () => {
  it("reuses the line's stripe-refund key, flips the sign, extracts Stripe ids", () => {
    const plan = planRefundBackfillRow(refundLine());
    expect(plan.kind).toBe("row");
    if (plan.kind !== "row") return;

    expect(plan.row.paymentEventKey).toBe("stripe-refund:re_Hist1");
    expect(plan.row.kind).toBe("REFUND");
    // Line stores -5000; ledger is positive with direction in kind.
    expect(plan.row.amountCents).toBe(5000);
    expect(plan.row.stripeRefundId).toBe("re_Hist1");
    expect(plan.row.stripeChargeId).toBe("ch_Hist1");
    expect(plan.row.stripeEventId).toBe("evt_Hist1");
    expect(plan.row.occurredAt.toISOString()).toBe("2026-04-01T09:30:00.000Z");
    expect(plan.row.metadata).toEqual({
      source: BACKFILL_METADATA_SOURCE,
      invoiceLineId: "line-refund-1",
    });
  });

  it("skips lines written while the refund was still pending (settle webhook owns the row)", () => {
    const plan = planRefundBackfillRow(
      refundLine({
        metadata: { sourceEvent: "operator-refund", stripeStatus: "pending" },
      })
    );
    expect(plan).toEqual({ kind: "skip-pending" });
  });

  it("falls back to the line's createdAt when metadata has no usable refundedAt", () => {
    const noTimestamp = planRefundBackfillRow(
      refundLine({ metadata: { stripeStatus: "succeeded" } })
    );
    if (noTimestamp.kind !== "row") throw new Error("expected row");
    expect(noTimestamp.row.occurredAt.toISOString()).toBe("2026-04-01T09:31:00.000Z");

    const garbageTimestamp = planRefundBackfillRow(
      refundLine({ metadata: { stripeStatus: "succeeded", refundedAt: "not-a-date" } })
    );
    if (garbageTimestamp.kind !== "row") throw new Error("expected row");
    expect(garbageTimestamp.row.occurredAt.toISOString()).toBe("2026-04-01T09:31:00.000Z");
  });

  it("tolerates non-object metadata (null / array / scalar)", () => {
    for (const metadata of [null, [], "junk", 42]) {
      const plan = planRefundBackfillRow(refundLine({ metadata }));
      expect(plan.kind).toBe("row");
    }
  });

  it("handles operator-initiated lines (no refundedAt, no stripeEventId in metadata)", () => {
    const plan = planRefundBackfillRow(
      refundLine({
        metadata: {
          sourceEvent: "operator-refund",
          stripeRefundId: "re_Hist1",
          stripeStatus: "succeeded",
          stripeChargeId: "ch_Hist1",
          reason: "requested_by_customer",
        },
      })
    );
    if (plan.kind !== "row") throw new Error("expected row");
    expect(plan.row.occurredAt.toISOString()).toBe("2026-04-01T09:31:00.000Z");
    expect("stripeEventId" in plan.row).toBe(false);
  });
});

describe("parseCli", () => {
  it("defaults to dry-run", () => {
    const parsed = parseCli([]);
    expect(parsed).toEqual({ execute: false });
  });

  it("requires --yes to execute and forwards --org", () => {
    const parsed = parseCli(["--yes", `--org=${ORG_ID}`]);
    expect(parsed).toEqual({ execute: true, organizationId: ORG_ID });
  });

  it("strips the pnpm -- separator", () => {
    const parsed = parseCli(["--", "--yes"]);
    expect(parsed).toEqual({ execute: true });
  });

  it("surfaces usage on --help", () => {
    const parsed = parseCli(["--help"]);
    expect("error" in parsed).toBe(true);
  });
});
