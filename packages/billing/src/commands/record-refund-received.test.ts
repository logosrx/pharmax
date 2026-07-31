// RecordRefundReceived contract tests.
//
// Surface:
//   - Already-recorded short-circuit: line already exists for
//     stripe-refund:{id} → no line re-write. The PAYMENT LEDGER
//     side still settles here: a succeeded delivery for a line
//     whose ledger row is missing (IssueRefund saw `pending`)
//     appends the REFUND row + emits payment.recorded; when the
//     ledger row already exists (synchronous succeeded refund)
//     it's a pure no-op.
//   - Out-of-band path: charge resolves to invoice, writes negative
//     line + REFUND ledger row, decrements totals, emits both v1s.
//   - Orphan charge: returns recognized=false cleanly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { Prisma } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

import { RecordRefundReceived } from "./record-refund-received.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const STRIPE_CHARGE_ID = "ch_Test";
const STRIPE_REFUND_ID = "re_Test";

interface FakeOverrides {
  existingLine?: {
    id: string;
    invoiceId: string;
    organizationId: string;
    clinicId: string;
  } | null;
  invoiceByCharge?: {
    id: string;
    organizationId: string;
    clinicId: string;
    invoiceNumber: string;
    amountDueCents: number;
    amountPaidCents: number;
    currency: string;
  } | null;
  /**
   * When true, `payment.create` throws P2002 and `payment.findUnique`
   * resolves the winner — simulates a ledger row that already exists
   * (synchronously-settled IssueRefund).
   */
  paymentRowAlreadyExists?: boolean;
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const tx = {
    invoiceLine: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoiceLine", op: "findUnique", args });
        return overrides.existingLine ?? null;
      }),
      // Prior-refund total for the over-refund reconciliation flag.
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoiceLine", op: "findMany", args });
        return [];
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoiceLine", op: "create", args });
        return { id: "line-new" };
      }),
    },
    invoice: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "findFirst", args });
        return overrides.invoiceByCharge ?? null;
      }),
      // Currency lookup for the short-circuit settle path.
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "findUnique", args });
        return { currency: "usd" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "update", args });
        return { id: INVOICE_ID };
      }),
    },
    payment: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "payment", op: "findMany", args });
        return [];
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "payment", op: "create", args });
        if (overrides.paymentRowAlreadyExists === true) {
          throw new Prisma.PrismaClientKnownRequestError("unique violation", {
            code: "P2002",
            clientVersion: "7.8.0",
          });
        }
        return { id: (args as { data: { id: string } }).data.id };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "payment", op: "findUnique", args });
        return overrides.paymentRowAlreadyExists === true ? { id: "payment-existing-1" } : null;
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "findUnique", args });
        return null;
      }),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al" })) },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (args: unknown) => {
        const data = args as {
          where: { organizationId: string };
          create: { latestHash: Buffer; latestSeq: bigint };
        };
        return {
          organizationId: data.where.organizationId,
          latestHash: data.create.latestHash,
          latestSeq: data.create.latestSeq,
        };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-06-01T11:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  const fake = buildPrismaFake();
  configureBus(fake.client);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

const validInput = {
  stripeChargeId: STRIPE_CHARGE_ID,
  stripeRefundId: STRIPE_REFUND_ID,
  amountCents: 5000,
  stripeStatus: "succeeded" as const,
  stripeReason: "requested_by_customer" as const,
  stripeEventId: "evt_TestRefund1",
  refundedAt: "2026-06-01T10:30:00.000Z",
};

const existingLineOverride = () => ({
  id: "line-already-1",
  invoiceId: INVOICE_ID,
  organizationId: ORG_ID,
  clinicId: CLINIC_ID,
});

describe("RecordRefundReceived — already-recorded short-circuit", () => {
  it("settles a pending refund: line exists but ledger row missing → REFUND row + payment.recorded", async () => {
    // IssueRefund wrote the line while Stripe reported `pending`;
    // this succeeded delivery is the settle moment.
    const fake = buildPrismaFake({ existingLine: existingLineOverride() });
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(RecordRefundReceived, validInput)
    );

    expect(out.alreadyRecorded).toBe(true);
    expect(out.recognized).toBe(true);
    // The invoice line is never re-written on this path.
    expect(fake.calls.filter((c) => c.table === "invoiceLine" && c.op === "create")).toHaveLength(
      0
    );

    const paymentCreates = fake.calls.filter((c) => c.table === "payment" && c.op === "create");
    expect(paymentCreates).toHaveLength(1);
    const data = (paymentCreates[0]!.args as { data: Record<string, unknown> }).data;
    expect(data["kind"]).toBe("REFUND");
    expect(data["amountCents"]).toBe(5000);
    expect(data["paymentEventKey"]).toBe(`stripe-refund:${STRIPE_REFUND_ID}`);

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (outboxCalls[0]!.args as { data: Array<{ eventType: string }> }).data;
    expect(outboxData.map((e) => e.eventType)).toEqual(["billing.payment.recorded.v1"]);
  });

  it("pure no-op when line AND ledger row both exist (synchronously-settled IssueRefund)", async () => {
    const fake = buildPrismaFake({
      existingLine: existingLineOverride(),
      paymentRowAlreadyExists: true,
    });
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(RecordRefundReceived, validInput)
    );

    expect(out.alreadyRecorded).toBe(true);
    expect(fake.calls.filter((c) => c.table === "invoiceLine" && c.op === "create")).toHaveLength(
      0
    );
    // P2002 converged on the existing row — nothing re-announced.
    expect(
      fake.calls.filter((c) => c.table === "eventOutbox" && c.op === "createMany")
    ).toHaveLength(0);
  });

  it("pure no-op when the line exists and the delivery is not succeeded (pending redelivery)", async () => {
    const fake = buildPrismaFake({ existingLine: existingLineOverride() });
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(RecordRefundReceived, { ...validInput, stripeStatus: "pending" })
    );

    expect(out.alreadyRecorded).toBe(true);
    expect(fake.calls.filter((c) => c.table === "payment" && c.op === "create")).toHaveLength(0);
    expect(
      fake.calls.filter((c) => c.table === "eventOutbox" && c.op === "createMany")
    ).toHaveLength(0);
  });
});

describe("RecordRefundReceived — out-of-band path", () => {
  it("writes negative line + REFUND ledger row + decrements totals + emits both v1s", async () => {
    const fake = buildPrismaFake({
      invoiceByCharge: {
        id: INVOICE_ID,
        organizationId: ORG_ID,
        clinicId: CLINIC_ID,
        invoiceNumber: "INV-2026-05-0c0c0c0c",
        amountDueCents: 0,
        amountPaidCents: 15000,
        currency: "usd",
      },
    });
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(RecordRefundReceived, validInput)
    );

    expect(out.recognized).toBe(true);
    expect(out.alreadyRecorded).toBe(false);

    const lineCreate = fake.calls.find((c) => c.table === "invoiceLine" && c.op === "create");
    const lineData = (lineCreate!.args as { data: Record<string, unknown> }).data;
    expect(lineData["amountCents"]).toBe(-5000);
    expect(lineData["billingEventKey"]).toBe(`stripe-refund:${STRIPE_REFUND_ID}`);

    const paymentCreates = fake.calls.filter((c) => c.table === "payment" && c.op === "create");
    expect(paymentCreates).toHaveLength(1);
    const paymentData = (paymentCreates[0]!.args as { data: Record<string, unknown> }).data;
    expect(paymentData["kind"]).toBe("REFUND");
    expect(paymentData["method"]).toBe("STRIPE");
    // Positive cents — direction lives in `kind`, not the sign.
    expect(paymentData["amountCents"]).toBe(5000);
    expect(paymentData["currency"]).toBe("usd");
    expect(paymentData["stripeRefundId"]).toBe(STRIPE_REFUND_ID);
    expect((paymentData["occurredAt"] as Date).toISOString()).toBe("2026-06-01T10:30:00.000Z");

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (
      outboxCalls[0]!.args as {
        data: Array<{ eventType: string; payload: Record<string, unknown> }>;
      }
    ).data;
    expect(outboxData[0]?.eventType).toBe("billing.invoice.refunded.v1");
    expect(outboxData[0]?.payload["source"]).toBe("stripe-webhook");
    expect(outboxData[1]?.eventType).toBe("billing.payment.recorded.v1");
    expect(outboxData[1]?.payload["kind"]).toBe("REFUND");
  });
});

describe("RecordRefundReceived — orphan", () => {
  it("returns recognized=false when charge not linked to any Pharmax invoice", async () => {
    const fake = buildPrismaFake({ invoiceByCharge: null });
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(RecordRefundReceived, validInput)
    );

    expect(out.recognized).toBe(false);
    expect(out.alreadyRecorded).toBe(false);
    expect(
      fake.calls.filter((c) => c.table === "eventOutbox" && c.op === "createMany")
    ).toHaveLength(0);
  });
});
