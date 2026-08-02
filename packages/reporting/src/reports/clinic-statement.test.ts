// clinic-statement report contract tests.
//
// Surface:
//   - Statement framing: BALANCE_FORWARD / CLOSING_BALANCE rows,
//     running balance, per-(clinic, currency) partitions, empty
//     partitions skipped.
//   - Issued-total reconstruction: post-issue manual credits are
//     added back onto INVOICE_ISSUED and shown as their own
//     CREDIT_APPLIED entries (including credits applied after the
//     window end, which affect the add-back but produce no entry).
//   - Pre-issue credits are baked into the issued total and never
//     shown as entries.
//   - Refund pair: stripe-refund credit line (CREDIT_APPLIED) +
//     settled ledger REFUND row (REFUND_ISSUED) net to zero.
//   - Clinic credit: an unapplied GRANT shows as CREDIT_GRANTED (−)
//     and leaves the closing balance in the clinic's favor;
//     pre-window grants feed the balance forward; an application's
//     CREDIT_BALANCE_APPLIED (+) nets against its paired
//     PAYMENT_RECEIVED "Credit balance" ledger row.
//   - Reference strings: manual instrument + check number, "Stripe"
//     for card collections, Stripe refund ids.

import { ClinicCreditEntryKind, PaymentKind, PaymentMethod } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clinicStatementReport } from "./clinic-statement.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_A = "0c0c0c0c-aaaa-4c0c-8c0c-aaaaaaaaaaaa";
const CLINIC_B = "0c0c0c0c-bbbb-4c0c-8c0c-bbbbbbbbbbbb";
const INV_1 = "1111aaaa-1111-4111-8111-000000000001";
const INV_2 = "1111aaaa-1111-4111-8111-000000000002";

const window = {
  from: new Date("2026-06-01T00:00:00.000Z"),
  to: new Date("2026-06-30T23:59:59.999Z"),
};

interface FakeInvoice {
  id: string;
  invoiceNumber: string;
  clinicId: string;
  currency: string;
  totalCents: number;
  issuedAt: Date;
}

interface FakeCreditLine {
  id: string;
  invoiceId: string;
  clinicId: string;
  amountCents: number;
  description: string;
  billingEventKey: string | null;
  createdAt: Date;
  invoice: { invoiceNumber: string; currency: string; issuedAt: Date };
}

interface FakeLedgerRow {
  id: string;
  clinicId: string;
  kind: PaymentKind;
  method: PaymentMethod;
  amountCents: number;
  currency: string;
  occurredAt: Date;
  stripeRefundId: string | null;
  metadata: unknown;
  invoice: { invoiceNumber: string };
}

interface FakeCreditEntry {
  id: string;
  clinicId: string;
  kind: ClinicCreditEntryKind;
  source: string | null;
  amountCents: number;
  currency: string;
  occurredAt: Date;
  metadata: unknown;
  appliedToInvoice: { invoiceNumber: string } | null;
}

interface Fixtures {
  invoices?: ReadonlyArray<FakeInvoice>;
  creditLines?: ReadonlyArray<FakeCreditLine>;
  ledgerRows?: ReadonlyArray<FakeLedgerRow>;
  creditEntries?: ReadonlyArray<FakeCreditEntry>;
}

function fakeClient(fixtures: Fixtures) {
  return {
    invoice: { findMany: vi.fn(async (_args: unknown) => fixtures.invoices ?? []) },
    invoiceLine: { findMany: vi.fn(async (_args: unknown) => fixtures.creditLines ?? []) },
    payment: { findMany: vi.fn(async (_args: unknown) => fixtures.ledgerRows ?? []) },
    clinicCreditEntry: { findMany: vi.fn(async (_args: unknown) => fixtures.creditEntries ?? []) },
  };
}

async function runReport(fixtures: Fixtures) {
  return await clinicStatementReport.run(
    { client: fakeClient(fixtures) as never, organizationId: ORG_ID },
    window
  );
}

afterEach(() => vi.restoreAllMocks());

describe("clinicStatementReport — statement framing", () => {
  it("frames each statement with balance forward, running balance, and closing balance", async () => {
    const result = await runReport({
      invoices: [
        // Pre-window: issued 150, paid 100 → balance forward 50.
        {
          id: INV_1,
          invoiceNumber: "INV-0001",
          clinicId: CLINIC_A,
          currency: "usd",
          totalCents: 15_000,
          issuedAt: new Date("2026-05-10T00:00:00.000Z"),
        },
        // In-window charge of 100.
        {
          id: INV_2,
          invoiceNumber: "INV-0002",
          clinicId: CLINIC_A,
          currency: "usd",
          totalCents: 10_000,
          issuedAt: new Date("2026-06-05T00:00:00.000Z"),
        },
      ],
      ledgerRows: [
        {
          id: "pay-pre",
          clinicId: CLINIC_A,
          kind: PaymentKind.PAYMENT,
          method: PaymentMethod.STRIPE,
          amountCents: 10_000,
          currency: "usd",
          occurredAt: new Date("2026-05-20T00:00:00.000Z"),
          stripeRefundId: null,
          metadata: null,
          invoice: { invoiceNumber: "INV-0001" },
        },
        // In-window manual partial payment of 60.
        {
          id: "pay-in",
          clinicId: CLINIC_A,
          kind: PaymentKind.PAYMENT,
          method: PaymentMethod.MANUAL,
          amountCents: 6_000,
          currency: "usd",
          occurredAt: new Date("2026-06-10T00:00:00.000Z"),
          stripeRefundId: null,
          metadata: { instrument: "CHECK", referenceNumber: "1234" },
          invoice: { invoiceNumber: "INV-0002" },
        },
      ],
    });

    expect(result.rows.map((r) => [r.entryType, r.amountCents, r.balanceCents])).toEqual([
      ["BALANCE_FORWARD", 5_000, 5_000],
      ["INVOICE_ISSUED", 10_000, 15_000],
      ["PAYMENT_RECEIVED", -6_000, 9_000],
      ["CLOSING_BALANCE", 9_000, 9_000],
    ]);

    // Manual payment reference = instrument + bank reference.
    const payment = result.rows.find((r) => r.entryType === "PAYMENT_RECEIVED");
    expect(payment).toMatchObject({ reference: "CHECK 1234", invoiceNumber: "INV-0002" });

    expect(result.aggregates).toMatchObject({
      statementCount: 1,
      clinicCount: 1,
      entryCount: 2,
      invoicedCents: 10_000,
      paymentsReceivedCents: 6_000,
      closingBalanceTotalCents: 9_000,
    });
  });

  it("partitions by clinic and skips clinics with no balance and no activity", async () => {
    const result = await runReport({
      invoices: [
        {
          id: INV_1,
          invoiceNumber: "INV-0001",
          clinicId: CLINIC_B,
          currency: "usd",
          totalCents: 5_000,
          issuedAt: new Date("2026-06-02T00:00:00.000Z"),
        },
      ],
      ledgerRows: [
        // CLINIC_A: paid in full pre-window → opening 0, no activity → no statement.
        {
          id: "pay-a",
          clinicId: CLINIC_A,
          kind: PaymentKind.PAYMENT,
          method: PaymentMethod.STRIPE,
          amountCents: 0,
          currency: "usd",
          occurredAt: new Date("2026-05-01T00:00:00.000Z"),
          stripeRefundId: null,
          metadata: null,
          invoice: { invoiceNumber: "INV-0000" },
        },
      ],
    });

    expect(new Set(result.rows.map((r) => r.clinicId))).toEqual(new Set([CLINIC_B]));
    expect(result.aggregates["statementCount"]).toBe(1);
  });
});

describe("clinicStatementReport — issued-total reconstruction", () => {
  const invoiceIssuedInWindow: FakeInvoice = {
    id: INV_1,
    invoiceNumber: "INV-0001",
    clinicId: CLINIC_A,
    currency: "usd",
    // Stored total is NET of the 2,000c manual credit below.
    totalCents: 13_000,
    issuedAt: new Date("2026-06-05T00:00:00.000Z"),
  };

  it("adds post-issue manual credits back onto INVOICE_ISSUED and shows them as entries", async () => {
    const result = await runReport({
      invoices: [invoiceIssuedInWindow],
      creditLines: [
        {
          id: "line-credit",
          invoiceId: INV_1,
          clinicId: CLINIC_A,
          amountCents: -2_000,
          description: "Goodwill credit for late delivery",
          billingEventKey: "manual-credit:01TESTULID",
          createdAt: new Date("2026-06-12T00:00:00.000Z"),
          invoice: {
            invoiceNumber: "INV-0001",
            currency: "usd",
            issuedAt: invoiceIssuedInWindow.issuedAt,
          },
        },
      ],
    });

    expect(result.rows.map((r) => [r.entryType, r.amountCents, r.balanceCents])).toEqual([
      ["BALANCE_FORWARD", 0, 0],
      // Issued at the ORIGINAL 15,000 (13,000 stored + 2,000 add-back) …
      ["INVOICE_ISSUED", 15_000, 15_000],
      // … with the credit as its own dated entry.
      ["CREDIT_APPLIED", -2_000, 13_000],
      ["CLOSING_BALANCE", 13_000, 13_000],
    ]);
    expect(result.rows[2]).toMatchObject({ reference: "Goodwill credit for late delivery" });
  });

  it("applies the add-back for credits after the window end without emitting an entry", async () => {
    const result = await runReport({
      invoices: [invoiceIssuedInWindow],
      creditLines: [
        {
          id: "line-late-credit",
          invoiceId: INV_1,
          clinicId: CLINIC_A,
          amountCents: -2_000,
          description: "July credit",
          billingEventKey: "manual-credit:01LATERULID",
          createdAt: new Date("2026-07-15T00:00:00.000Z"),
          invoice: {
            invoiceNumber: "INV-0001",
            currency: "usd",
            issuedAt: invoiceIssuedInWindow.issuedAt,
          },
        },
      ],
    });

    // June's statement shows the invoice as issued (15,000); July's
    // credit belongs to July's statement.
    expect(result.rows.map((r) => [r.entryType, r.amountCents])).toEqual([
      ["BALANCE_FORWARD", 0],
      ["INVOICE_ISSUED", 15_000],
      ["CLOSING_BALANCE", 15_000],
    ]);
  });

  it("never shows pre-issue credits as entries (they are baked into the issued total)", async () => {
    const result = await runReport({
      invoices: [invoiceIssuedInWindow],
      creditLines: [
        {
          id: "line-pre-issue",
          invoiceId: INV_1,
          clinicId: CLINIC_A,
          amountCents: -1_000,
          description: "Draft-stage discount",
          billingEventKey: "manual-credit:01EARLYULID",
          createdAt: new Date("2026-06-04T00:00:00.000Z"),
          invoice: {
            invoiceNumber: "INV-0001",
            currency: "usd",
            issuedAt: invoiceIssuedInWindow.issuedAt,
          },
        },
      ],
    });

    // No CREDIT_APPLIED entry and NO add-back: the stored total
    // already reflected the credit at issue time.
    expect(result.rows.map((r) => [r.entryType, r.amountCents])).toEqual([
      ["BALANCE_FORWARD", 0],
      ["INVOICE_ISSUED", 13_000],
      ["CLOSING_BALANCE", 13_000],
    ]);
  });
});

describe("clinicStatementReport — refunds", () => {
  it("nets a settled refund to zero via the CREDIT_APPLIED / REFUND_ISSUED pair", async () => {
    const issuedAt = new Date("2026-05-01T00:00:00.000Z");
    const result = await runReport({
      invoices: [
        {
          id: INV_1,
          invoiceNumber: "INV-0001",
          clinicId: CLINIC_A,
          currency: "usd",
          totalCents: 15_000,
          issuedAt,
        },
      ],
      creditLines: [
        {
          id: "line-refund",
          invoiceId: INV_1,
          clinicId: CLINIC_A,
          amountCents: -3_000,
          description: "Refund (re_Test1)",
          billingEventKey: "stripe-refund:re_Test1",
          createdAt: new Date("2026-06-08T10:00:00.000Z"),
          invoice: { invoiceNumber: "INV-0001", currency: "usd", issuedAt },
        },
      ],
      ledgerRows: [
        // Pre-window full payment …
        {
          id: "pay-1",
          clinicId: CLINIC_A,
          kind: PaymentKind.PAYMENT,
          method: PaymentMethod.STRIPE,
          amountCents: 15_000,
          currency: "usd",
          occurredAt: new Date("2026-05-02T00:00:00.000Z"),
          stripeRefundId: null,
          metadata: null,
          invoice: { invoiceNumber: "INV-0001" },
        },
        // … and the in-window settled refund.
        {
          id: "ref-1",
          clinicId: CLINIC_A,
          kind: PaymentKind.REFUND,
          method: PaymentMethod.STRIPE,
          amountCents: 3_000,
          currency: "usd",
          occurredAt: new Date("2026-06-08T10:00:05.000Z"),
          stripeRefundId: "re_Test1",
          metadata: null,
          invoice: { invoiceNumber: "INV-0001" },
        },
      ],
    });

    // Refund credit lines do NOT hit totalCents — no add-back, so
    // the pre-window charge (15,000) and payment (−15,000) cancel.
    expect(result.rows.map((r) => [r.entryType, r.amountCents, r.balanceCents])).toEqual([
      ["BALANCE_FORWARD", 0, 0],
      // Charge reduced ("we owe you 30") …
      ["CREDIT_APPLIED", -3_000, -3_000],
      // … then the cash went back ("and we've paid it").
      ["REFUND_ISSUED", 3_000, 0],
      ["CLOSING_BALANCE", 0, 0],
    ]);
    expect(result.rows[2]).toMatchObject({ reference: "re_Test1" });
    expect(result.aggregates).toMatchObject({
      creditedCents: 3_000,
      refundsIssuedCents: 3_000,
      closingBalanceTotalCents: 0,
    });
  });
});

describe("clinicStatementReport — clinic credit", () => {
  it("shows an unapplied grant as CREDIT_GRANTED and a closing balance in the clinic's favor", async () => {
    const result = await runReport({
      invoices: [
        {
          id: INV_1,
          invoiceNumber: "INV-0001",
          clinicId: CLINIC_A,
          currency: "usd",
          totalCents: 40_000,
          issuedAt: new Date("2026-06-05T00:00:00.000Z"),
        },
      ],
      ledgerRows: [
        // The clinic's $500 check: $400 recorded against the invoice …
        {
          id: "pay-1",
          clinicId: CLINIC_A,
          kind: PaymentKind.PAYMENT,
          method: PaymentMethod.MANUAL,
          amountCents: 40_000,
          currency: "usd",
          occurredAt: new Date("2026-06-10T00:00:00.000Z"),
          stripeRefundId: null,
          metadata: { instrument: "CHECK", referenceNumber: "1234" },
          invoice: { invoiceNumber: "INV-0001" },
        },
      ],
      creditEntries: [
        // … and the $100 excess granted as credit at the same instant.
        {
          id: "credit-grant-1",
          clinicId: CLINIC_A,
          kind: ClinicCreditEntryKind.GRANT,
          source: "OVERPAYMENT",
          amountCents: 10_000,
          currency: "usd",
          occurredAt: new Date("2026-06-10T00:00:00.000Z"),
          metadata: { referenceNumber: "check 1234" },
          appliedToInvoice: null,
        },
      ],
    });

    expect(result.rows.map((r) => [r.entryType, r.amountCents, r.balanceCents])).toEqual([
      ["BALANCE_FORWARD", 0, 0],
      ["INVOICE_ISSUED", 40_000, 40_000],
      // Same timestamp: the payment settles the invoice first, then
      // the excess becomes stored credit.
      ["PAYMENT_RECEIVED", -40_000, 0],
      ["CREDIT_GRANTED", -10_000, -10_000],
      // Closing balance is NEGATIVE — the clinic holds $100 credit.
      ["CLOSING_BALANCE", -10_000, -10_000],
    ]);
    const grant = result.rows.find((r) => r.entryType === "CREDIT_GRANTED");
    expect(grant).toMatchObject({ reference: "OVERPAYMENT check 1234", invoiceNumber: "" });
    expect(result.aggregates).toMatchObject({
      creditGrantedCents: 10_000,
      creditBalanceAppliedCents: 0,
      closingBalanceTotalCents: -10_000,
    });
  });

  it("nets an application to zero via the PAYMENT_RECEIVED / CREDIT_BALANCE_APPLIED pair", async () => {
    const appliedAt = new Date("2026-06-20T00:00:00.000Z");
    const result = await runReport({
      invoices: [
        {
          id: INV_2,
          invoiceNumber: "INV-0002",
          clinicId: CLINIC_A,
          currency: "usd",
          totalCents: 20_000,
          issuedAt: new Date("2026-06-15T00:00:00.000Z"),
        },
      ],
      ledgerRows: [
        // The CREDIT_BALANCE settle written by ApplyClinicCredit.
        {
          id: "pay-credit",
          clinicId: CLINIC_A,
          kind: PaymentKind.PAYMENT,
          method: PaymentMethod.CREDIT_BALANCE,
          amountCents: 10_000,
          currency: "usd",
          occurredAt: appliedAt,
          stripeRefundId: null,
          metadata: null,
          invoice: { invoiceNumber: "INV-0002" },
        },
      ],
      creditEntries: [
        // Pre-window grant → feeds the balance forward (−100).
        {
          id: "credit-grant-pre",
          clinicId: CLINIC_A,
          kind: ClinicCreditEntryKind.GRANT,
          source: "GOODWILL",
          amountCents: 10_000,
          currency: "usd",
          occurredAt: new Date("2026-05-15T00:00:00.000Z"),
          metadata: null,
          appliedToInvoice: null,
        },
        // In-window application, paired with the ledger row above.
        {
          id: "credit-apply-1",
          clinicId: CLINIC_A,
          kind: ClinicCreditEntryKind.APPLICATION,
          source: null,
          amountCents: 10_000,
          currency: "usd",
          occurredAt: appliedAt,
          metadata: null,
          appliedToInvoice: { invoiceNumber: "INV-0002" },
        },
      ],
    });

    expect(result.rows.map((r) => [r.entryType, r.amountCents, r.balanceCents])).toEqual([
      // Balance forward carries the May grant: clinic starts $100 in credit.
      ["BALANCE_FORWARD", -10_000, -10_000],
      ["INVOICE_ISSUED", 20_000, 10_000],
      // The application pair nets to zero — the balance effect of the
      // credit happened at grant time.
      ["PAYMENT_RECEIVED", -10_000, 0],
      ["CREDIT_BALANCE_APPLIED", 10_000, 10_000],
      // Clinic still owes the uncovered $100 of the invoice.
      ["CLOSING_BALANCE", 10_000, 10_000],
    ]);
    const application = result.rows.find((r) => r.entryType === "CREDIT_BALANCE_APPLIED");
    expect(application).toMatchObject({ reference: "Credit balance", invoiceNumber: "INV-0002" });
    const payment = result.rows.find((r) => r.entryType === "PAYMENT_RECEIVED");
    expect(payment).toMatchObject({ reference: "Credit balance" });
    expect(result.aggregates).toMatchObject({
      creditGrantedCents: 0,
      creditBalanceAppliedCents: 10_000,
      paymentsReceivedCents: 10_000,
      closingBalanceTotalCents: 10_000,
    });
  });
});
