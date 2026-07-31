// invoice-aging report contract tests.
//
// The bucket math itself is owned (and tested) by
// `@pharmax/billing`'s `listAgedInvoices`; these tests pin the
// report-level contract: flattening to CSV-friendly rows,
// aggregate tile keys, tenant/clinic scoping, and the point-in-time
// window semantics.
//
// Synthetic data only — fake uuids, fake invoice numbers, cents.

import { afterEach, describe, expect, it, vi } from "vitest";

import { invoiceAgingReport } from "./invoice-aging.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_A = "0c0c0c0c-aaaa-4c0c-8c0c-aaaaaaaaaaaa";
const CLINIC_B = "0c0c0c0c-bbbb-4c0c-8c0c-bbbbbbbbbbbb";

const AS_OF = new Date("2026-07-01T23:59:59.999Z");
const DAY_MS = 24 * 60 * 60 * 1000;

interface FakeInvoiceRow {
  id: string;
  invoiceNumber: string;
  clinicId: string;
  currency: string;
  totalCents: number;
  amountDueCents: number;
  issuedAt: Date | null;
  dueAt: Date | null;
}

function fakeInvoice(overrides: Partial<FakeInvoiceRow> & { id: string }): FakeInvoiceRow {
  return {
    invoiceNumber: `INV-${overrides.id.slice(0, 4)}`,
    clinicId: CLINIC_A,
    currency: "usd",
    totalCents: 10_000,
    amountDueCents: 10_000,
    issuedAt: new Date(AS_OF.getTime() - 40 * DAY_MS),
    dueAt: new Date(AS_OF.getTime() - 10 * DAY_MS),
    ...overrides,
  };
}

function fakeClient(rows: ReadonlyArray<FakeInvoiceRow>) {
  return {
    invoice: { findMany: vi.fn(async () => rows) },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("invoiceAgingReport — rows", () => {
  it("flattens invoices into CSV-friendly rows with bucket + daysOverdue", async () => {
    const client = fakeClient([
      fakeInvoice({
        id: "inv-1",
        dueAt: new Date(AS_OF.getTime() + 5 * DAY_MS), // not yet due
      }),
      fakeInvoice({
        id: "inv-2",
        dueAt: new Date(AS_OF.getTime() - 45 * DAY_MS), // 45 days overdue
        amountDueCents: 2_500,
      }),
    ]);

    const result = await invoiceAgingReport.run(
      { client: client as never, organizationId: ORG_ID },
      { asOf: AS_OF }
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      invoiceId: "inv-1",
      bucket: "CURRENT",
      daysOverdue: 0,
    });
    expect(result.rows[1]).toMatchObject({
      invoiceId: "inv-2",
      bucket: "DAYS_31_60",
      daysOverdue: 45,
      amountDueCents: 2_500,
    });
  });

  it("serializes issuedAt/dueAt as YYYY-MM-DD and null dates as empty string", async () => {
    const client = fakeClient([
      fakeInvoice({
        id: "inv-1",
        issuedAt: new Date("2026-05-20T08:30:00.000Z"),
        dueAt: null,
      }),
    ]);

    const result = await invoiceAgingReport.run(
      { client: client as never, organizationId: ORG_ID },
      { asOf: AS_OF }
    );

    expect(result.rows[0]).toMatchObject({
      issuedAt: "2026-05-20",
      dueAt: "",
      // Defensive default in listAgedInvoices: no due date → CURRENT.
      bucket: "CURRENT",
    });
  });
});

describe("invoiceAgingReport — aggregates", () => {
  it("publishes per-bucket count + amountDue tiles and org totals", async () => {
    const client = fakeClient([
      fakeInvoice({
        id: "inv-1",
        dueAt: new Date(AS_OF.getTime() + DAY_MS),
        amountDueCents: 1_000,
      }),
      fakeInvoice({
        id: "inv-2",
        dueAt: new Date(AS_OF.getTime() - 5 * DAY_MS),
        amountDueCents: 2_000,
      }),
      fakeInvoice({
        id: "inv-3",
        dueAt: new Date(AS_OF.getTime() - 100 * DAY_MS),
        amountDueCents: 4_000,
        clinicId: CLINIC_B,
      }),
    ]);

    const result = await invoiceAgingReport.run(
      { client: client as never, organizationId: ORG_ID },
      { asOf: AS_OF }
    );

    expect(result.aggregates).toEqual({
      invoiceCount: 3,
      totalAmountDueCents: 7_000,
      currentCount: 1,
      currentAmountDueCents: 1_000,
      days1To30Count: 1,
      days1To30AmountDueCents: 2_000,
      days31To60Count: 0,
      days31To60AmountDueCents: 0,
      days61To90Count: 0,
      days61To90AmountDueCents: 0,
      over90Count: 1,
      over90AmountDueCents: 4_000,
    });
  });
});

describe("invoiceAgingReport — scoping + window", () => {
  it("scopes the query by organizationId and OPEN status; narrows by ctx.clinicId", async () => {
    const client = fakeClient([]);
    await invoiceAgingReport.run(
      { client: client as never, organizationId: ORG_ID, clinicId: CLINIC_B },
      { asOf: AS_OF }
    );

    const callArgs = client.invoice.findMany.mock.calls[0] as ReadonlyArray<unknown>;
    const call = callArgs[0] as { where: Record<string, unknown> };
    expect(call.where["organizationId"]).toBe(ORG_ID);
    expect(call.where["status"]).toBe("OPEN");
    expect(call.where["clinicId"]).toBe(CLINIC_B);
  });

  it("degenerates the window to [asOf, asOf] and stamps generatedAt = asOf", async () => {
    const client = fakeClient([]);
    const result = await invoiceAgingReport.run(
      { client: client as never, organizationId: ORG_ID },
      { asOf: AS_OF }
    );

    expect(result.window).toEqual({ from: AS_OF, to: AS_OF });
    expect(result.generatedAt).toEqual(AS_OF);
  });

  it("falls back to ctx.asOf when the asOf parameter is omitted", async () => {
    const client = fakeClient([]);
    const result = await invoiceAgingReport.run(
      { client: client as never, organizationId: ORG_ID, asOf: AS_OF },
      {}
    );
    expect(result.generatedAt).toEqual(AS_OF);
  });
});

describe("invoiceAgingReport — schema", () => {
  it("accepts an empty parameter object (asOf optional)", () => {
    expect(invoiceAgingReport.parametersSchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown keys (strict)", () => {
    expect(invoiceAgingReport.parametersSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});
