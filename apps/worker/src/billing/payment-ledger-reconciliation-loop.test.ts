// Unit tests for the nightly payment-ledger reconciliation loop.
//
// Drives the real `createPaymentLedgerReconciliationLoop` against a
// fixture-driven fake Prisma so the reconciliation semantics are
// exercised end-to-end without a database. Focus areas:
//
//   - Clean parity produces zero drift.
//   - Each drift kind fires on exactly its shape:
//       PAYMENT_ROWS_MISSING / PAYMENT_SUM_MISMATCH /
//       REFUND_LEDGER_EXCEEDS_LINES / PAYMENT_ON_UNPAID_INVOICE.
//   - Pending refunds (lines > ledger) are informational, NOT drift.
//   - Zero-amount PAID invoices with no ledger rows are clean.
//   - One org's query failure must not stop the remaining orgs.
//   - Cursor pagination visits every PAID invoice.
//   - Drift reporting truncates at maxReportedDrifts with the flag set.

import { InvoiceStatus, PaymentKind, type PrismaClient } from "@pharmax/database";
import { logger as loggerNs } from "@pharmax/platform-core";
import { describe, expect, it, vi } from "vitest";

import { createPaymentLedgerReconciliationLoop } from "./payment-ledger-reconciliation-loop.js";

const ORG_A = "11111111-1111-7111-a111-111111111111";
const ORG_B = "22222222-2222-7222-a222-222222222222";

const logger = loggerNs.createPinoLogger({
  service: "test-payment-ledger-reconciliation",
  level: "error",
});

const fixedNow = new Date("2026-07-31T03:30:00Z");

interface FakeInvoice {
  readonly id: string;
  readonly organizationId: string;
  readonly invoiceNumber: string;
  readonly status: InvoiceStatus;
  readonly amountPaidCents: number;
}

interface FakePaymentRow {
  readonly invoiceId: string;
  readonly organizationId: string;
  readonly kind: PaymentKind;
  readonly amountCents: number;
}

interface FakeRefundLine {
  readonly invoiceId: string;
  /** Stored negative, as CREDIT lines are in production. */
  readonly amountCents: number;
  readonly billingEventKey: string;
}

interface Fixtures {
  readonly orgs: ReadonlyArray<{ readonly id: string; readonly slug: string }>;
  readonly invoices: ReadonlyArray<FakeInvoice>;
  readonly payments: ReadonlyArray<FakePaymentRow>;
  readonly refundLines: ReadonlyArray<FakeRefundLine>;
  /** When set, invoice.findMany throws for this organizationId. */
  readonly failInvoiceScanForOrg?: string;
}

function buildPrismaFake(fixtures: Fixtures): PrismaClient {
  const invoiceStatusById = new Map(fixtures.invoices.map((inv) => [inv.id, inv.status]));
  return {
    organization: {
      findMany: vi.fn(async () => fixtures.orgs),
    },
    invoice: {
      findMany: vi.fn(
        async (args: {
          where: {
            organizationId: string;
            status: { in: ReadonlyArray<InvoiceStatus> };
            id?: { gt: string };
          };
          take: number;
        }) => {
          if (args.where.organizationId === fixtures.failInvoiceScanForOrg) {
            throw new Error("simulated invoice scan failure");
          }
          const cursor = args.where.id?.gt ?? null;
          const statuses = new Set(args.where.status.in);
          return fixtures.invoices
            .filter(
              (inv) =>
                inv.organizationId === args.where.organizationId &&
                statuses.has(inv.status) &&
                (cursor === null || inv.id > cursor)
            )
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .slice(0, args.take)
            .map((inv) => ({
              id: inv.id,
              invoiceNumber: inv.invoiceNumber,
              amountPaidCents: inv.amountPaidCents,
            }));
        }
      ),
    },
    payment: {
      findMany: vi.fn(
        async (args: {
          where: {
            invoiceId?: { in: ReadonlyArray<string> };
            organizationId?: string;
            invoice?: { status: { notIn: ReadonlyArray<InvoiceStatus> } };
          };
        }) => {
          if (args.where.invoice !== undefined) {
            // Orphan query: rows whose invoice status is NOT in the excluded set.
            const excluded = new Set(args.where.invoice.status.notIn);
            return fixtures.payments
              .filter((row) => {
                const status = invoiceStatusById.get(row.invoiceId);
                return (
                  row.organizationId === args.where.organizationId &&
                  status !== undefined &&
                  !excluded.has(status)
                );
              })
              .map((row) => ({ invoiceId: row.invoiceId, amountCents: row.amountCents }));
          }
          const ids = new Set(args.where.invoiceId?.in ?? []);
          return fixtures.payments
            .filter((row) => ids.has(row.invoiceId))
            .map((row) => ({
              invoiceId: row.invoiceId,
              kind: row.kind,
              amountCents: row.amountCents,
            }));
        }
      ),
    },
    invoiceLine: {
      findMany: vi.fn(async (args: { where: { invoiceId: { in: ReadonlyArray<string> } } }) => {
        const ids = new Set(args.where.invoiceId.in);
        return fixtures.refundLines
          .filter(
            (line) => ids.has(line.invoiceId) && line.billingEventKey.startsWith("stripe-refund:")
          )
          .map((line) => ({ invoiceId: line.invoiceId, amountCents: line.amountCents }));
      }),
    },
  } as unknown as PrismaClient;
}

function buildLoop(
  fixtures: Fixtures,
  overrides?: { readonly maxReportedDrifts?: number; readonly pageSize?: number }
) {
  return createPaymentLedgerReconciliationLoop({
    prisma: buildPrismaFake(fixtures),
    logger,
    now: () => fixedNow,
    ...(overrides?.maxReportedDrifts !== undefined
      ? { maxReportedDrifts: overrides.maxReportedDrifts }
      : {}),
    ...(overrides?.pageSize !== undefined ? { pageSize: overrides.pageSize } : {}),
  });
}

const INV_1 = "aaaaaaa1-0000-7000-a000-000000000001";
const INV_2 = "aaaaaaa2-0000-7000-a000-000000000002";
const INV_3 = "aaaaaaa3-0000-7000-a000-000000000003";

describe("createPaymentLedgerReconciliationLoop", () => {
  it("reports a fully clean run when ledger and projection agree", async () => {
    const loop = buildLoop({
      orgs: [
        { id: ORG_A, slug: "org-a" },
        { id: ORG_B, slug: "org-b" },
      ],
      invoices: [
        {
          id: INV_1,
          organizationId: ORG_A,
          invoiceNumber: "INV-0001",
          status: InvoiceStatus.PAID,
          amountPaidCents: 5_000,
        },
        {
          id: INV_2,
          organizationId: ORG_B,
          invoiceNumber: "INV-0002",
          status: InvoiceStatus.PAID,
          amountPaidCents: 12_000,
        },
      ],
      payments: [
        { invoiceId: INV_1, organizationId: ORG_A, kind: PaymentKind.PAYMENT, amountCents: 5_000 },
        { invoiceId: INV_2, organizationId: ORG_B, kind: PaymentKind.PAYMENT, amountCents: 12_000 },
      ],
      refundLines: [],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.organizationCount).toBe(2);
    expect(summary.orgsClean).toBe(2);
    expect(summary.orgsWithDrift).toBe(0);
    expect(summary.orgsFailed).toBe(0);
    expect(summary.invoicesChecked).toBe(2);
    expect(summary.driftCount).toBe(0);
    expect(summary.drifts).toEqual([]);
    expect(summary.driftsTruncated).toBe(false);
  });

  it("flags a paid invoice with no ledger rows as PAYMENT_ROWS_MISSING", async () => {
    const loop = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [
        {
          id: INV_1,
          organizationId: ORG_A,
          invoiceNumber: "INV-0001",
          status: InvoiceStatus.PAID,
          amountPaidCents: 5_000,
        },
      ],
      payments: [],
      refundLines: [],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.orgsWithDrift).toBe(1);
    expect(summary.driftCount).toBe(1);
    expect(summary.drifts[0]).toMatchObject({
      invoiceId: INV_1,
      invoiceNumber: "INV-0001",
      driftKind: "PAYMENT_ROWS_MISSING",
      expectedCents: 5_000,
      actualCents: 0,
    });
    expect(summary.driftByKind["PAYMENT_ROWS_MISSING"]).toBe(1);
  });

  it("flags a ledger sum that disagrees with amountPaidCents as PAYMENT_SUM_MISMATCH", async () => {
    const loop = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [
        {
          id: INV_1,
          organizationId: ORG_A,
          invoiceNumber: "INV-0001",
          status: InvoiceStatus.PAID,
          amountPaidCents: 5_000,
        },
      ],
      payments: [
        { invoiceId: INV_1, organizationId: ORG_A, kind: PaymentKind.PAYMENT, amountCents: 4_000 },
      ],
      refundLines: [],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.driftCount).toBe(1);
    expect(summary.drifts[0]).toMatchObject({
      driftKind: "PAYMENT_SUM_MISMATCH",
      expectedCents: 5_000,
      actualCents: 4_000,
    });
  });

  it("flags PAYMENT rows on an invoice whose projection says zero paid", async () => {
    // amountPaidCents === 0 but ledger rows exist — the "projection
    // lost an update" direction of the mismatch.
    const loop = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [
        {
          id: INV_1,
          organizationId: ORG_A,
          invoiceNumber: "INV-0001",
          status: InvoiceStatus.PAID,
          amountPaidCents: 0,
        },
      ],
      payments: [
        { invoiceId: INV_1, organizationId: ORG_A, kind: PaymentKind.PAYMENT, amountCents: 2_500 },
      ],
      refundLines: [],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.driftCount).toBe(1);
    expect(summary.drifts[0]).toMatchObject({
      driftKind: "PAYMENT_SUM_MISMATCH",
      expectedCents: 0,
      actualCents: 2_500,
    });
  });

  it("treats a zero-amount PAID invoice with no ledger rows as clean", async () => {
    const loop = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [
        {
          id: INV_1,
          organizationId: ORG_A,
          invoiceNumber: "INV-0001",
          status: InvoiceStatus.PAID,
          amountPaidCents: 0,
        },
      ],
      payments: [],
      refundLines: [],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.orgsClean).toBe(1);
    expect(summary.driftCount).toBe(0);
  });

  it("flags a REFUND ledger sum above the stripe-refund line total", async () => {
    const loop = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [
        {
          id: INV_1,
          organizationId: ORG_A,
          invoiceNumber: "INV-0001",
          status: InvoiceStatus.PAID,
          amountPaidCents: 5_000,
        },
      ],
      payments: [
        { invoiceId: INV_1, organizationId: ORG_A, kind: PaymentKind.PAYMENT, amountCents: 5_000 },
        { invoiceId: INV_1, organizationId: ORG_A, kind: PaymentKind.REFUND, amountCents: 2_000 },
      ],
      refundLines: [
        { invoiceId: INV_1, amountCents: -1_000, billingEventKey: "stripe-refund:re_1" },
      ],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.driftCount).toBe(1);
    expect(summary.drifts[0]).toMatchObject({
      driftKind: "REFUND_LEDGER_EXCEEDS_LINES",
      expectedCents: 1_000,
      actualCents: 2_000,
    });
  });

  it("counts a pending refund (lines above ledger) as unsettled, not drift", async () => {
    const loop = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [
        {
          id: INV_1,
          organizationId: ORG_A,
          invoiceNumber: "INV-0001",
          status: InvoiceStatus.PAID,
          amountPaidCents: 5_000,
        },
      ],
      payments: [
        { invoiceId: INV_1, organizationId: ORG_A, kind: PaymentKind.PAYMENT, amountCents: 5_000 },
      ],
      refundLines: [
        { invoiceId: INV_1, amountCents: -1_500, billingEventKey: "stripe-refund:re_pending" },
      ],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.driftCount).toBe(0);
    expect(summary.orgsClean).toBe(1);
    expect(summary.unsettledRefundInvoices).toBe(1);
    expect(summary.unsettledRefundCents).toBe(1_500);
  });

  it("treats an OPEN invoice with a matching partial manual payment as clean", async () => {
    // RecordManualPayment shape: $60 check against a $100 invoice —
    // still OPEN, amountPaid=6000, one MANUAL PAYMENT ledger row.
    const loop = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [
        {
          id: INV_1,
          organizationId: ORG_A,
          invoiceNumber: "INV-0001",
          status: InvoiceStatus.OPEN,
          amountPaidCents: 6_000,
        },
      ],
      payments: [
        { invoiceId: INV_1, organizationId: ORG_A, kind: PaymentKind.PAYMENT, amountCents: 6_000 },
      ],
      refundLines: [],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.driftCount).toBe(0);
    expect(summary.orgsClean).toBe(1);
    expect(summary.invoicesChecked).toBe(1);
  });

  it("flags an OPEN invoice whose ledger disagrees with the projection", async () => {
    const loop = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [
        {
          id: INV_1,
          organizationId: ORG_A,
          invoiceNumber: "INV-0001",
          status: InvoiceStatus.OPEN,
          amountPaidCents: 0,
        },
      ],
      payments: [
        { invoiceId: INV_1, organizationId: ORG_A, kind: PaymentKind.PAYMENT, amountCents: 3_000 },
      ],
      refundLines: [],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.driftCount).toBe(1);
    expect(summary.drifts[0]).toMatchObject({
      driftKind: "PAYMENT_SUM_MISMATCH",
      expectedCents: 0,
      actualCents: 3_000,
    });
  });

  it("flags ledger rows referencing a DRAFT invoice as PAYMENT_ON_UNPAID_INVOICE", async () => {
    const loop = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [
        {
          id: INV_1,
          organizationId: ORG_A,
          invoiceNumber: "INV-0001",
          status: InvoiceStatus.DRAFT,
          amountPaidCents: 0,
        },
      ],
      payments: [
        { invoiceId: INV_1, organizationId: ORG_A, kind: PaymentKind.PAYMENT, amountCents: 3_000 },
      ],
      refundLines: [],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.driftCount).toBe(1);
    expect(summary.drifts[0]).toMatchObject({
      invoiceId: INV_1,
      invoiceNumber: null,
      driftKind: "PAYMENT_ON_UNPAID_INVOICE",
      expectedCents: 0,
      actualCents: 3_000,
    });
  });

  it("isolates a failing org so the remaining orgs are still reconciled", async () => {
    const loop = buildLoop({
      orgs: [
        { id: ORG_A, slug: "org-a" },
        { id: ORG_B, slug: "org-b" },
      ],
      invoices: [
        {
          id: INV_2,
          organizationId: ORG_B,
          invoiceNumber: "INV-0002",
          status: InvoiceStatus.PAID,
          amountPaidCents: 12_000,
        },
      ],
      payments: [
        { invoiceId: INV_2, organizationId: ORG_B, kind: PaymentKind.PAYMENT, amountCents: 12_000 },
      ],
      refundLines: [],
      failInvoiceScanForOrg: ORG_A,
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.orgsFailed).toBe(1);
    expect(summary.orgsClean).toBe(1);
    expect(summary.invoicesChecked).toBe(1);
  });

  it("pages through PAID invoices with the cursor until exhausted", async () => {
    const invoiceIds = [INV_1, INV_2, INV_3];
    const fixtures: Fixtures = {
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: invoiceIds.map((id, index) => ({
        id,
        organizationId: ORG_A,
        invoiceNumber: `INV-000${index + 1}`,
        status: InvoiceStatus.PAID,
        amountPaidCents: 1_000,
      })),
      payments: invoiceIds.map((invoiceId) => ({
        invoiceId,
        organizationId: ORG_A,
        kind: PaymentKind.PAYMENT,
        amountCents: 1_000,
      })),
      refundLines: [],
    };
    const loop = buildLoop(fixtures, { pageSize: 2 });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.invoicesChecked).toBe(3);
    expect(summary.orgsClean).toBe(1);
    expect(summary.driftCount).toBe(0);
  });

  it("truncates reported drift records at maxReportedDrifts and sets the flag", async () => {
    const invoiceIds = [INV_1, INV_2, INV_3];
    const loop = buildLoop(
      {
        orgs: [{ id: ORG_A, slug: "org-a" }],
        invoices: invoiceIds.map((id, index) => ({
          id,
          organizationId: ORG_A,
          invoiceNumber: `INV-000${index + 1}`,
          status: InvoiceStatus.PAID,
          amountPaidCents: 1_000,
        })),
        // No ledger rows at all → every invoice drifts.
        payments: [],
        refundLines: [],
      },
      { maxReportedDrifts: 2 }
    );

    const summary = await loop.runOnce(fixedNow);

    expect(summary.driftCount).toBe(3);
    expect(summary.drifts).toHaveLength(2);
    expect(summary.driftsTruncated).toBe(true);
    expect(summary.driftByKind["PAYMENT_ROWS_MISSING"]).toBe(3);
  });

  it("produces a coherent zero summary when no organizations exist", async () => {
    const loop = buildLoop({ orgs: [], invoices: [], payments: [], refundLines: [] });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.organizationCount).toBe(0);
    expect(summary.invoicesChecked).toBe(0);
    expect(summary.driftCount).toBe(0);
    expect(summary.orgsClean).toBe(0);
    expect(summary.orgsFailed).toBe(0);
  });

  it("freezes driftByKind so the summary cannot be mutated downstream", async () => {
    const loop = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [
        {
          id: INV_1,
          organizationId: ORG_A,
          invoiceNumber: "INV-0001",
          status: InvoiceStatus.PAID,
          amountPaidCents: 1_000,
        },
      ],
      payments: [],
      refundLines: [],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(Object.isFrozen(summary.driftByKind)).toBe(true);
  });

  it("exposes a startable/stoppable daily scheduler", async () => {
    const loop = buildLoop({ orgs: [], invoices: [], payments: [], refundLines: [] });

    loop.start();
    expect(loop.scheduler).toBeDefined();
    await loop.stop();
  });
});
