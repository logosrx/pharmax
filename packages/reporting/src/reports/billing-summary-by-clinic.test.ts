import { InvoiceStatus } from "@pharmax/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { billingSummaryByClinicReport } from "./billing-summary-by-clinic.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_A = "0c0c0c0c-aaaa-4c0c-8c0c-aaaaaaaaaaaa";
const CLINIC_B = "0c0c0c0c-bbbb-4c0c-8c0c-bbbbbbbbbbbb";

interface FakeGroup {
  clinicId: string;
  status: InvoiceStatus;
  _count: { _all: number };
  _sum: {
    totalCents: number | null;
    amountPaidCents: number | null;
    amountDueCents: number | null;
  };
}

function fakeClient(groups: ReadonlyArray<FakeGroup>) {
  return {
    invoice: { groupBy: vi.fn(async () => groups) },
  };
}

const window = {
  from: new Date("2026-05-01T00:00:00.000Z"),
  to: new Date("2026-05-31T23:59:59.999Z"),
};

afterEach(() => vi.restoreAllMocks());

describe("billingSummaryByClinicReport — aggregates", () => {
  it("sums totals/paid/due across clinics + statuses", async () => {
    const client = fakeClient([
      {
        clinicId: CLINIC_A,
        status: InvoiceStatus.PAID,
        _count: { _all: 4 },
        _sum: { totalCents: 40000, amountPaidCents: 40000, amountDueCents: 0 },
      },
      {
        clinicId: CLINIC_A,
        status: InvoiceStatus.OPEN,
        _count: { _all: 2 },
        _sum: { totalCents: 20000, amountPaidCents: 0, amountDueCents: 20000 },
      },
      {
        clinicId: CLINIC_B,
        status: InvoiceStatus.OPEN,
        _count: { _all: 1 },
        _sum: { totalCents: 5000, amountPaidCents: 0, amountDueCents: 5000 },
      },
    ]);
    const result = await billingSummaryByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );

    expect(result.rows).toHaveLength(3);
    expect(result.aggregates).toEqual({
      invoiceCount: 7,
      totalInvoicedCents: 65000,
      totalPaidCents: 40000,
      totalDueCents: 25000,
      distinctGroups: 3,
    });
  });

  it("coerces null _sum (no rows in a group) to 0", async () => {
    const client = fakeClient([
      {
        clinicId: CLINIC_A,
        status: InvoiceStatus.VOID,
        _count: { _all: 1 },
        _sum: { totalCents: null, amountPaidCents: null, amountDueCents: null },
      },
    ]);
    const result = await billingSummaryByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    expect(result.rows[0]).toMatchObject({ totalCents: 0, amountPaidCents: 0, amountDueCents: 0 });
  });

  it("sorts by clinicId then status", async () => {
    const client = fakeClient([
      {
        clinicId: CLINIC_B,
        status: InvoiceStatus.PAID,
        _count: { _all: 1 },
        _sum: { totalCents: 1, amountPaidCents: 1, amountDueCents: 0 },
      },
      {
        clinicId: CLINIC_A,
        status: InvoiceStatus.OPEN,
        _count: { _all: 1 },
        _sum: { totalCents: 1, amountPaidCents: 0, amountDueCents: 1 },
      },
      {
        clinicId: CLINIC_A,
        status: InvoiceStatus.DRAFT,
        _count: { _all: 1 },
        _sum: { totalCents: 1, amountPaidCents: 0, amountDueCents: 1 },
      },
    ]);
    const result = await billingSummaryByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      window
    );
    // CLINIC_A before CLINIC_B; within A, DRAFT before OPEN (enum order).
    expect(result.rows.map((r) => `${r.clinicId === CLINIC_A ? "A" : "B"}:${r.status}`)).toEqual([
      "A:DRAFT",
      "A:OPEN",
      "B:PAID",
    ]);
  });
});

describe("billingSummaryByClinicReport — query shape", () => {
  it("groups by (clinicId, status), filters issuedAt window + optional statuses", async () => {
    const client = fakeClient([]);
    await billingSummaryByClinicReport.run(
      { client: client as never, organizationId: ORG_ID },
      { ...window, statuses: [InvoiceStatus.OPEN, InvoiceStatus.PAID] }
    );
    const callArgs = client.invoice.groupBy.mock.calls[0] as ReadonlyArray<unknown>;
    const call = callArgs[0] as {
      by: ReadonlyArray<string>;
      where: Record<string, unknown>;
      _sum: Record<string, boolean>;
    };
    expect(call.by).toEqual(["clinicId", "status"]);
    expect(call.where["issuedAt"]).toEqual({ gte: window.from, lte: window.to });
    expect(call.where["status"]).toEqual({ in: [InvoiceStatus.OPEN, InvoiceStatus.PAID] });
    expect(call._sum).toMatchObject({
      totalCents: true,
      amountPaidCents: true,
      amountDueCents: true,
    });
  });
});

describe("billingSummaryByClinicReport — schema", () => {
  it("rejects from > to", () => {
    expect(
      billingSummaryByClinicReport.parametersSchema.safeParse({
        from: new Date("2026-06-01"),
        to: new Date("2026-05-01"),
      }).success
    ).toBe(false);
  });
});
