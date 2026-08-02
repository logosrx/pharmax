// payments-received report contract tests.
//
// Surface:
//   - Query shape: org scope always present, kind pinned to PAYMENT,
//     occurredAt window, optional clinic narrow + method filter.
//   - Row mapping: invoice number joined, instrument / reference
//     extracted from JSON metadata ("" when absent), ISO timestamps.
//   - Aggregates: total + per-method sums, distinct invoice/clinic
//     counts.

import { PaymentMethod } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { paymentsReceivedReport } from "./payments-received.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_A = "0c0c0c0c-aaaa-4c0c-8c0c-aaaaaaaaaaaa";
const CLINIC_B = "0c0c0c0c-bbbb-4c0c-8c0c-bbbbbbbbbbbb";
const INV_1 = "1111aaaa-1111-4111-8111-000000000001";
const INV_2 = "1111aaaa-1111-4111-8111-000000000002";

interface FakePaymentRow {
  id: string;
  occurredAt: Date;
  invoiceId: string;
  clinicId: string;
  method: PaymentMethod;
  amountCents: number;
  currency: string;
  metadata: unknown;
  invoice: { invoiceNumber: string };
}

function fakeClient(rows: ReadonlyArray<FakePaymentRow>) {
  const findMany = vi.fn(async (_args: unknown) => rows);
  return { client: { payment: { findMany } }, findMany };
}

const window = {
  from: new Date("2026-06-01T00:00:00.000Z"),
  to: new Date("2026-06-30T23:59:59.999Z"),
};

const stripeRow = (over: Partial<FakePaymentRow> = {}): FakePaymentRow => ({
  id: "pay-1",
  occurredAt: new Date("2026-06-03T12:00:00.000Z"),
  invoiceId: INV_1,
  clinicId: CLINIC_A,
  method: PaymentMethod.STRIPE,
  amountCents: 10_000,
  currency: "usd",
  metadata: { sourceEvent: "stripe-webhook-invoice-paid" },
  invoice: { invoiceNumber: "INV-0001" },
  ...over,
});

const manualRow = (over: Partial<FakePaymentRow> = {}): FakePaymentRow => ({
  id: "pay-2",
  occurredAt: new Date("2026-06-10T09:00:00.000Z"),
  invoiceId: INV_2,
  clinicId: CLINIC_B,
  method: PaymentMethod.MANUAL,
  amountCents: 6_000,
  currency: "usd",
  metadata: {
    sourceEvent: "operator-manual-payment",
    instrument: "CHECK",
    referenceNumber: "1234",
  },
  invoice: { invoiceNumber: "INV-0002" },
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("paymentsReceivedReport — query shape", () => {
  it("pins kind=PAYMENT, scopes by org, and windows over occurredAt", async () => {
    const { client, findMany } = fakeClient([]);
    await paymentsReceivedReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = findMany.mock.calls[0]![0] as unknown as { where: Record<string, unknown> };
    expect(args.where["organizationId"]).toBe(ORG_ID);
    expect(args.where["kind"]).toBe("PAYMENT");
    expect(args.where["occurredAt"]).toEqual({ gte: window.from, lte: window.to });
    expect(args.where["clinicId"]).toBeUndefined();
    expect(args.where["method"]).toBeUndefined();
  });

  it("narrows by clinic and method when provided", async () => {
    const { client, findMany } = fakeClient([]);
    await paymentsReceivedReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_A },
      { ...window, methods: [PaymentMethod.MANUAL] }
    );

    const args = findMany.mock.calls[0]![0] as unknown as { where: Record<string, unknown> };
    expect(args.where["clinicId"]).toBe(CLINIC_A);
    expect(args.where["method"]).toEqual({ in: [PaymentMethod.MANUAL] });
  });

  it("rejects an inverted date range at the schema boundary", () => {
    const parsed = paymentsReceivedReport.parametersSchema.safeParse({
      from: window.to,
      to: window.from,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("paymentsReceivedReport — rows + aggregates", () => {
  it("maps rows with instrument/reference from metadata and sums per method", async () => {
    const { client } = fakeClient([stripeRow(), manualRow()]);
    const result = await paymentsReceivedReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      paymentId: "pay-1",
      occurredAt: "2026-06-03T12:00:00.000Z",
      invoiceId: INV_1,
      invoiceNumber: "INV-0001",
      clinicId: CLINIC_A,
      method: PaymentMethod.STRIPE,
      instrument: "",
      referenceNumber: "",
      amountCents: 10_000,
      currency: "usd",
    });
    expect(result.rows[1]).toMatchObject({
      method: PaymentMethod.MANUAL,
      instrument: "CHECK",
      referenceNumber: "1234",
    });

    expect(result.aggregates).toEqual({
      paymentCount: 2,
      totalReceivedCents: 16_000,
      stripeReceivedCents: 10_000,
      manualReceivedCents: 6_000,
      creditBalanceAppliedCents: 0,
      distinctInvoiceCount: 2,
      distinctClinicCount: 2,
    });
  });

  it("counts distinct invoices once across partial payments", async () => {
    const { client } = fakeClient([
      manualRow({ id: "pay-a", invoiceId: INV_1, clinicId: CLINIC_A, amountCents: 4_000 }),
      manualRow({ id: "pay-b", invoiceId: INV_1, clinicId: CLINIC_A, amountCents: 6_000 }),
    ]);
    const result = await paymentsReceivedReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.aggregates["paymentCount"]).toBe(2);
    expect(result.aggregates["totalReceivedCents"]).toBe(10_000);
    expect(result.aggregates["distinctInvoiceCount"]).toBe(1);
    expect(result.aggregates["distinctClinicCount"]).toBe(1);
  });

  it("tolerates null / malformed metadata with empty-string fallbacks", async () => {
    const { client } = fakeClient([
      manualRow({ metadata: null }),
      manualRow({ id: "pay-3", metadata: { instrument: 42 } }),
    ]);
    const result = await paymentsReceivedReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows[0]).toMatchObject({ instrument: "", referenceNumber: "" });
    expect(result.rows[1]).toMatchObject({ instrument: "", referenceNumber: "" });
  });
});
