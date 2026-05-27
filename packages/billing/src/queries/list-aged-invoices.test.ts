// listAgedInvoices contract tests.
//
// Pure-classifier path tested by direct call into the function with
// a stubbed `prisma.invoice.findMany`. No bus, no tenancy frame —
// the query is a read-only helper.

import { describe, expect, it, vi } from "vitest";

import { classifyAgingBucket, listAgedInvoices, type AgingBucket } from "./list-aged-invoices.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_A = "0c0c0c0c-0c0c-4c0c-8c0c-aaaaaaaaaaaa";
const CLINIC_B = "0c0c0c0c-0c0c-4c0c-8c0c-bbbbbbbbbbbb";

const AS_OF = new Date("2026-05-31T00:00:00.000Z");

interface InvoiceFixture {
  id: string;
  invoiceNumber: string;
  clinicId: string;
  currency: string;
  totalCents: number;
  amountDueCents: number;
  issuedAt: Date | null;
  dueAt: Date | null;
}

function fakeClient(rows: ReadonlyArray<InvoiceFixture>): {
  invoice: { findMany: ReturnType<typeof vi.fn> };
} {
  return {
    invoice: { findMany: vi.fn(async () => rows) },
  };
}

describe("classifyAgingBucket", () => {
  it.each<[number, AgingBucket]>([
    [-1, "CURRENT"],
    [0, "CURRENT"],
    [1, "DAYS_1_30"],
    [30, "DAYS_1_30"],
    [31, "DAYS_31_60"],
    [60, "DAYS_31_60"],
    [61, "DAYS_61_90"],
    [90, "DAYS_61_90"],
    [91, "DAYS_OVER_90"],
    [365, "DAYS_OVER_90"],
  ])("classifies %d days → %s", (days, bucket) => {
    expect(classifyAgingBucket(days)).toBe(bucket);
  });
});

describe("listAgedInvoices — bucketing", () => {
  it("buckets a mixed set of invoices into the expected tiers", async () => {
    const client = fakeClient([
      {
        id: "inv-current",
        invoiceNumber: "INV-1",
        clinicId: CLINIC_A,
        currency: "usd",
        totalCents: 10000,
        amountDueCents: 10000,
        issuedAt: new Date("2026-05-25T00:00:00.000Z"),
        // Due in the future → CURRENT
        dueAt: new Date("2026-06-15T00:00:00.000Z"),
      },
      {
        id: "inv-1-30",
        invoiceNumber: "INV-2",
        clinicId: CLINIC_A,
        currency: "usd",
        totalCents: 5000,
        amountDueCents: 5000,
        issuedAt: new Date("2026-04-01T00:00:00.000Z"),
        // Due 20 days ago → DAYS_1_30
        dueAt: new Date("2026-05-11T00:00:00.000Z"),
      },
      {
        id: "inv-31-60",
        invoiceNumber: "INV-3",
        clinicId: CLINIC_B,
        currency: "usd",
        totalCents: 7500,
        amountDueCents: 7500,
        issuedAt: new Date("2026-03-01T00:00:00.000Z"),
        // Due 45 days ago → DAYS_31_60
        dueAt: new Date("2026-04-16T00:00:00.000Z"),
      },
      {
        id: "inv-over-90",
        invoiceNumber: "INV-4",
        clinicId: CLINIC_B,
        currency: "usd",
        totalCents: 3000,
        amountDueCents: 3000,
        issuedAt: new Date("2025-12-01T00:00:00.000Z"),
        // Due ~150 days ago → DAYS_OVER_90
        dueAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const report = await listAgedInvoices(
      client as unknown as Parameters<typeof listAgedInvoices>[0],
      { organizationId: ORG_ID, asOf: AS_OF }
    );

    expect(report.invoices).toHaveLength(4);

    const buckets = report.buckets;
    expect(buckets.find((b) => b.bucket === "CURRENT")?.invoiceCount).toBe(1);
    expect(buckets.find((b) => b.bucket === "DAYS_1_30")?.invoiceCount).toBe(1);
    expect(buckets.find((b) => b.bucket === "DAYS_31_60")?.invoiceCount).toBe(1);
    expect(buckets.find((b) => b.bucket === "DAYS_61_90")?.invoiceCount).toBe(0);
    expect(buckets.find((b) => b.bucket === "DAYS_OVER_90")?.invoiceCount).toBe(1);

    // Per-clinic totals.
    const clinicA = report.byClinic.find((c) => c.clinicId === CLINIC_A);
    expect(clinicA?.invoiceCount).toBe(2);
    expect(clinicA?.totalAmountDueCents).toBe(15000);

    const clinicB = report.byClinic.find((c) => c.clinicId === CLINIC_B);
    expect(clinicB?.invoiceCount).toBe(2);
    expect(clinicB?.totalAmountDueCents).toBe(10500);

    // Spot-check one classified row.
    const overdue = report.invoices.find((i) => i.invoiceId === "inv-over-90");
    expect(overdue?.bucket).toBe("DAYS_OVER_90");
    expect(overdue?.daysOverdue).toBeGreaterThan(90);
  });

  it("scopes by clinicId when provided (passes through to Prisma WHERE)", async () => {
    const client = fakeClient([]);
    await listAgedInvoices(client as unknown as Parameters<typeof listAgedInvoices>[0], {
      organizationId: ORG_ID,
      clinicId: CLINIC_A,
      asOf: AS_OF,
    });
    const callArgs = client.invoice.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(callArgs.where["clinicId"]).toBe(CLINIC_A);
    expect(callArgs.where["organizationId"]).toBe(ORG_ID);
    expect(callArgs.where["status"]).toBe("OPEN");
  });

  it("returns empty bucket totals + empty invoices when no rows match", async () => {
    const client = fakeClient([]);
    const report = await listAgedInvoices(
      client as unknown as Parameters<typeof listAgedInvoices>[0],
      { organizationId: ORG_ID, asOf: AS_OF }
    );
    expect(report.invoices).toHaveLength(0);
    expect(report.byClinic).toHaveLength(0);
    for (const b of report.buckets) {
      expect(b.invoiceCount).toBe(0);
      expect(b.totalAmountDueCents).toBe(0);
    }
  });

  it("treats null dueAt as CURRENT", async () => {
    const client = fakeClient([
      {
        id: "inv-no-due",
        invoiceNumber: "INV-no-due",
        clinicId: CLINIC_A,
        currency: "usd",
        totalCents: 1000,
        amountDueCents: 1000,
        issuedAt: null,
        dueAt: null,
      },
    ]);
    const report = await listAgedInvoices(
      client as unknown as Parameters<typeof listAgedInvoices>[0],
      { organizationId: ORG_ID, asOf: AS_OF }
    );
    expect(report.invoices[0]?.bucket).toBe("CURRENT");
    expect(report.invoices[0]?.daysOverdue).toBe(0);
  });
});
