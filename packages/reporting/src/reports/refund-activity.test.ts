// refund-activity report contract tests.
//
// Surface:
//   - Query shape: org scope always present, kind pinned to REFUND,
//     occurredAt window, optional clinic narrow.
//   - Row mapping: invoice number joined, null stripeRefundId → "",
//     amounts stay positive (direction lives in kind).
//   - Aggregates: total + per-method sums, distinct invoice/clinic
//     counts.

import { PaymentMethod } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { refundActivityReport } from "./refund-activity.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_A = "0c0c0c0c-aaaa-4c0c-8c0c-aaaaaaaaaaaa";
const INV_1 = "1111aaaa-1111-4111-8111-000000000001";
const INV_2 = "1111aaaa-1111-4111-8111-000000000002";

interface FakeRefundRow {
  id: string;
  occurredAt: Date;
  invoiceId: string;
  clinicId: string;
  method: PaymentMethod;
  stripeRefundId: string | null;
  amountCents: number;
  currency: string;
  invoice: { invoiceNumber: string };
}

function fakeClient(rows: ReadonlyArray<FakeRefundRow>) {
  const findMany = vi.fn(async (_args: unknown) => rows);
  return { client: { payment: { findMany } }, findMany };
}

const window = {
  from: new Date("2026-06-01T00:00:00.000Z"),
  to: new Date("2026-06-30T23:59:59.999Z"),
};

const refundRow = (over: Partial<FakeRefundRow> = {}): FakeRefundRow => ({
  id: "ref-1",
  occurredAt: new Date("2026-06-05T15:30:00.000Z"),
  invoiceId: INV_1,
  clinicId: CLINIC_A,
  method: PaymentMethod.STRIPE,
  stripeRefundId: "re_Test1",
  amountCents: 2_500,
  currency: "usd",
  invoice: { invoiceNumber: "INV-0001" },
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("refundActivityReport — query shape", () => {
  it("pins kind=REFUND, scopes by org, and windows over occurredAt", async () => {
    const { client, findMany } = fakeClient([]);
    await refundActivityReport.run({ client: client as never, organizationId: ORG_ID }, window);

    const args = findMany.mock.calls[0]![0] as unknown as { where: Record<string, unknown> };
    expect(args.where["organizationId"]).toBe(ORG_ID);
    expect(args.where["kind"]).toBe("REFUND");
    expect(args.where["occurredAt"]).toEqual({ gte: window.from, lte: window.to });
    expect(args.where["clinicId"]).toBeUndefined();
  });

  it("narrows by clinic when provided", async () => {
    const { client, findMany } = fakeClient([]);
    await refundActivityReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_A },
      window
    );

    const args = findMany.mock.calls[0]![0] as unknown as { where: Record<string, unknown> };
    expect(args.where["clinicId"]).toBe(CLINIC_A);
  });

  it("rejects an inverted date range at the schema boundary", () => {
    const parsed = refundActivityReport.parametersSchema.safeParse({
      from: window.to,
      to: window.from,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("refundActivityReport — rows + aggregates", () => {
  it("maps rows, keeps amounts positive, and sums per method", async () => {
    const { client } = fakeClient([
      refundRow(),
      refundRow({
        id: "ref-2",
        invoiceId: INV_2,
        method: PaymentMethod.MANUAL,
        stripeRefundId: null,
        amountCents: 1_000,
        invoice: { invoiceNumber: "INV-0002" },
      }),
    ]);
    const result = await refundActivityReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows[0]).toEqual({
      paymentId: "ref-1",
      occurredAt: "2026-06-05T15:30:00.000Z",
      invoiceId: INV_1,
      invoiceNumber: "INV-0001",
      clinicId: CLINIC_A,
      method: PaymentMethod.STRIPE,
      stripeRefundId: "re_Test1",
      amountCents: 2_500,
      currency: "usd",
    });
    expect(result.rows[1]).toMatchObject({ stripeRefundId: "", amountCents: 1_000 });

    expect(result.aggregates).toEqual({
      refundCount: 2,
      totalRefundedCents: 3_500,
      stripeRefundedCents: 2_500,
      manualRefundedCents: 1_000,
      distinctInvoiceCount: 2,
      distinctClinicCount: 1,
    });
  });

  it("returns an empty register with zeroed aggregates", async () => {
    const { client } = fakeClient([]);
    const result = await refundActivityReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(0);
    expect(result.aggregates).toEqual({
      refundCount: 0,
      totalRefundedCents: 0,
      stripeRefundedCents: 0,
      manualRefundedCents: 0,
      distinctInvoiceCount: 0,
      distinctClinicCount: 0,
    });
  });
});
