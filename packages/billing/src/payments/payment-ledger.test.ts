// Payment-ledger helper tests.
//
// Covers:
//   - insertPaymentLedgerRow: happy insert, positive-amount guard,
//     P2002 convergence (created=false + winner's id), non-P2002
//     rethrow.
//   - paymentRecordedOutboxEvent: payload shape matches the
//     `billing.payment.recorded.v1` schema fields.
//   - computePriorRefundedCents: max-of-both-sources semantics
//     (line scan vs. ledger sum) that keeps the refund budget
//     safe both before and after the backfill.

import { describe, expect, it, vi } from "vitest";

import type { PrismaTxClient } from "@pharmax/command-bus";
import { PaymentKind, PaymentMethod, Prisma } from "@pharmax/database";

import {
  computePriorRefundedCents,
  insertPaymentLedgerRow,
  type PaymentLedgerRowInput,
  paymentRecordedOutboxEvent,
} from "./payment-ledger.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";

const rowInput = (overrides: Partial<PaymentLedgerRowInput> = {}): PaymentLedgerRowInput => ({
  organizationId: ORG_ID,
  clinicId: CLINIC_ID,
  invoiceId: INVOICE_ID,
  kind: PaymentKind.PAYMENT,
  method: PaymentMethod.STRIPE,
  amountCents: 5000,
  currency: "usd",
  paymentEventKey: "stripe-paid:evt_Test1",
  occurredAt: new Date("2026-06-01T10:00:00.000Z"),
  ...overrides,
});

function fakeTx(overrides: {
  createError?: Error;
  existingRowId?: string;
}): PrismaTxClient & { calls: Array<{ op: string; args: unknown }> } {
  const calls: Array<{ op: string; args: unknown }> = [];
  const tx = {
    calls,
    payment: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ op: "create", args });
        if (overrides.createError !== undefined) throw overrides.createError;
        return { id: (args as { data: { id: string } }).data.id };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ op: "findUnique", args });
        return overrides.existingRowId !== undefined ? { id: overrides.existingRowId } : null;
      }),
    },
  };
  return tx as unknown as PrismaTxClient & { calls: Array<{ op: string; args: unknown }> };
}

describe("insertPaymentLedgerRow", () => {
  it("inserts the row and returns created=true", async () => {
    const tx = fakeTx({});
    const result = await insertPaymentLedgerRow(tx, rowInput());

    expect(result.created).toBe(true);
    const createCall = tx.calls.find((c) => c.op === "create");
    const data = (createCall!.args as { data: Record<string, unknown> }).data;
    expect(data["id"]).toBe(result.paymentId);
    expect(data["kind"]).toBe("PAYMENT");
    expect(data["amountCents"]).toBe(5000);
    expect(data["paymentEventKey"]).toBe("stripe-paid:evt_Test1");
    // Optional Stripe ids default to explicit nulls.
    expect(data["stripeEventId"]).toBeNull();
    expect(data["stripeRefundId"]).toBeNull();
  });

  it.each([0, -5000, 12.5])("rejects non-positive / non-integer amount %s", async (amount) => {
    const tx = fakeTx({});
    await expect(insertPaymentLedgerRow(tx, rowInput({ amountCents: amount }))).rejects.toThrow(
      /positive integers/
    );
    expect(tx.calls).toHaveLength(0);
  });

  it("converges on the winner's row on a P2002 race (created=false)", async () => {
    const tx = fakeTx({
      createError: new Prisma.PrismaClientKnownRequestError("unique violation", {
        code: "P2002",
        clientVersion: "7.8.0",
      }),
      existingRowId: "payment-winner-1",
    });

    const result = await insertPaymentLedgerRow(tx, rowInput());
    expect(result).toEqual({ paymentId: "payment-winner-1", created: false });
  });

  it("rethrows non-P2002 errors", async () => {
    const tx = fakeTx({ createError: new Error("connection reset") });
    await expect(insertPaymentLedgerRow(tx, rowInput())).rejects.toThrow("connection reset");
  });
});

describe("paymentRecordedOutboxEvent", () => {
  it("builds the billing.payment.recorded.v1 draft from the row", () => {
    const row = rowInput({ kind: PaymentKind.REFUND, amountCents: 1234 });
    const draft = paymentRecordedOutboxEvent({ paymentId: "payment-1", row });

    expect(draft.eventType).toBe("billing.payment.recorded.v1");
    expect(draft.aggregateType).toBe("Invoice");
    expect(draft.aggregateId).toBe(INVOICE_ID);
    expect(draft.payload).toEqual({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      invoiceId: INVOICE_ID,
      paymentId: "payment-1",
      kind: "REFUND",
      method: "STRIPE",
      amountCents: 1234,
      currency: "usd",
      paymentEventKey: "stripe-paid:evt_Test1",
      occurredAt: "2026-06-01T10:00:00.000Z",
    });
  });
});

describe("computePriorRefundedCents", () => {
  function refundTx(input: {
    lineCents: ReadonlyArray<number>;
    ledgerCents: ReadonlyArray<number>;
  }): PrismaTxClient {
    return {
      invoiceLine: {
        findMany: vi.fn(async () => input.lineCents.map((amountCents) => ({ amountCents }))),
      },
      payment: {
        findMany: vi.fn(async () => input.ledgerCents.map((amountCents) => ({ amountCents }))),
      },
    } as unknown as PrismaTxClient;
  }

  it("takes the MAX of the line scan and the ledger sum", async () => {
    // Lines store refunds as negative amounts; ledger rows are positive.
    const totals = await computePriorRefundedCents(
      refundTx({ lineCents: [-8000], ledgerCents: [5000, 8000] }),
      INVOICE_ID
    );
    expect(totals).toEqual({
      priorRefundedCents: 13000,
      fromInvoiceLinesCents: 8000,
      fromPaymentLedgerCents: 13000,
    });
  });

  it("falls back to the line scan when the ledger is behind (pre-backfill)", async () => {
    const totals = await computePriorRefundedCents(
      refundTx({ lineCents: [-8000, -2000], ledgerCents: [] }),
      INVOICE_ID
    );
    expect(totals.priorRefundedCents).toBe(10000);
    expect(totals.fromPaymentLedgerCents).toBe(0);
  });

  it("returns zero for an invoice with no refunds", async () => {
    const totals = await computePriorRefundedCents(
      refundTx({ lineCents: [], ledgerCents: [] }),
      INVOICE_ID
    );
    expect(totals.priorRefundedCents).toBe(0);
  });
});
