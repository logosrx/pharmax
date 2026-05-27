// listInvoices + getInvoiceDetail contract tests.

import { afterEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_A = "1111aaaa-1111-4111-8111-000000000001";
const INVOICE_B = "1111aaaa-1111-4111-8111-000000000002";

const prismaMock = {
  invoice: { findMany: vi.fn(), findFirst: vi.fn() },
};

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
}));

const { listInvoices, getInvoiceDetail } = await import("./list-invoices.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("listInvoices — pagination", () => {
  it("returns rows + null nextCursor when result count <= limit", async () => {
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      {
        id: INVOICE_A,
        invoiceNumber: "INV-1",
        clinicId: CLINIC_ID,
        status: "OPEN",
        currency: "usd",
        subtotalCents: 15000,
        totalCents: 15000,
        amountPaidCents: 0,
        amountDueCents: 15000,
        issuedAt: new Date("2026-05-25T00:00:00.000Z"),
        dueAt: new Date("2026-06-24T00:00:00.000Z"),
        paidAt: null,
        stripeInvoiceId: null,
        version: 5,
        createdAt: new Date("2026-05-25T00:00:00.000Z"),
        _count: { lines: 3 },
      },
    ]);

    const result = await listInvoices({ organizationId: ORG_ID, limit: 50 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      invoiceId: INVOICE_A,
      lineCount: 3,
    });
    expect(result.nextCursor).toBeNull();
  });

  it("returns nextCursor when more rows exist", async () => {
    // Returns limit+1 rows; helper trims to limit and reports cursor.
    prismaMock.invoice.findMany.mockResolvedValueOnce([
      {
        id: INVOICE_A,
        invoiceNumber: "INV-1",
        clinicId: CLINIC_ID,
        status: "OPEN",
        currency: "usd",
        subtotalCents: 0,
        totalCents: 0,
        amountPaidCents: 0,
        amountDueCents: 0,
        issuedAt: null,
        dueAt: null,
        paidAt: null,
        stripeInvoiceId: null,
        version: 0,
        createdAt: new Date(),
        _count: { lines: 0 },
      },
      {
        id: INVOICE_B,
        invoiceNumber: "INV-2",
        clinicId: CLINIC_ID,
        status: "OPEN",
        currency: "usd",
        subtotalCents: 0,
        totalCents: 0,
        amountPaidCents: 0,
        amountDueCents: 0,
        issuedAt: null,
        dueAt: null,
        paidAt: null,
        stripeInvoiceId: null,
        version: 0,
        createdAt: new Date(),
        _count: { lines: 0 },
      },
    ]);
    const result = await listInvoices({ organizationId: ORG_ID, limit: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.nextCursor).toBe(INVOICE_A);
  });

  it("forwards optional filters into the WHERE clause", async () => {
    prismaMock.invoice.findMany.mockResolvedValueOnce([]);
    await listInvoices({
      organizationId: ORG_ID,
      status: "PAID" as never,
      clinicId: CLINIC_ID,
    });
    const calls = prismaMock.invoice.findMany.mock.calls as unknown as Array<
      [{ where: Record<string, unknown> }]
    >;
    expect(calls[0]![0].where["status"]).toBe("PAID");
    expect(calls[0]![0].where["clinicId"]).toBe(CLINIC_ID);
    expect(calls[0]![0].where["organizationId"]).toBe(ORG_ID);
  });
});

describe("getInvoiceDetail — projection", () => {
  it("returns null when the invoice does not exist in the tenancy", async () => {
    prismaMock.invoice.findFirst.mockResolvedValueOnce(null);
    const detail = await getInvoiceDetail({ organizationId: ORG_ID, invoiceId: INVOICE_A });
    expect(detail).toBeNull();
  });

  it("projects the invoice + lines into the presentation shape", async () => {
    prismaMock.invoice.findFirst.mockResolvedValueOnce({
      id: INVOICE_A,
      invoiceNumber: "INV-1",
      clinicId: CLINIC_ID,
      status: "PAID",
      currency: "usd",
      subtotalCents: 15000,
      totalCents: 15000,
      amountPaidCents: 15000,
      amountDueCents: 0,
      issuedAt: new Date("2026-05-25T00:00:00.000Z"),
      dueAt: new Date("2026-06-24T00:00:00.000Z"),
      paidAt: new Date("2026-05-30T00:00:00.000Z"),
      voidedAt: null,
      stripeInvoiceId: "in_TestInv",
      stripeCustomerId: "cus_TestCust",
      stripeChargeId: "ch_TestCharge",
      version: 6,
      createdAt: new Date("2026-05-25T00:00:00.000Z"),
      lines: [
        {
          id: "line-1",
          kind: "DISPENSE_FEE",
          description: "Shipped prescription order",
          quantity: 1,
          unitAmountCents: 5000,
          amountCents: 5000,
          orderId: "00000000-0000-4000-8000-0000000000aa",
          createdAt: new Date(),
        },
      ],
    });
    const detail = await getInvoiceDetail({ organizationId: ORG_ID, invoiceId: INVOICE_A });
    expect(detail).toMatchObject({
      invoiceId: INVOICE_A,
      status: "PAID",
      stripeChargeId: "ch_TestCharge",
      amountDueCents: 0,
    });
    expect(detail?.lines).toHaveLength(1);
    expect(detail?.lines[0]?.amountCents).toBe(5000);
  });
});
