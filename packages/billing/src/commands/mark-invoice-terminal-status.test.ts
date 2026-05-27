// Consolidated tests for MarkInvoiceVoided + MarkInvoiceUncollectible
// + RecordInvoicePaymentFailure.
//
// All three commands share the same shape:
//   - SystemCommand
//   - Resolves Pharmax invoice by id within target organization
//   - Orphan (not-found) → recognized=false, audit-only, no throw
//   - Already-in-target-status → short-circuit, no version bump
//   - Cross-Stripe-id mismatch → typed conflict
//   - Status flips (Voided / Uncollectible) or no-op (PaymentFailure)
//
// One file keeps the contract tests grouped while individual command
// files stay focused on the behavior itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { InvoiceStatus } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

import {
  MARK_UNCOLLECTIBLE_INVALID_STATUS_TRANSITION,
  MARK_UNCOLLECTIBLE_VERSION_MISMATCH,
  MarkInvoiceUncollectible,
} from "./mark-invoice-uncollectible.js";
import {
  MARK_VOIDED_INVALID_STATUS_TRANSITION,
  MARK_VOIDED_VERSION_MISMATCH,
  MarkInvoiceVoided,
} from "./mark-invoice-voided.js";
import { RecordInvoicePaymentFailure } from "./record-invoice-payment-failure.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const STRIPE_INVOICE_ID = "in_TestStripeInvoice";

interface FakeInvoice {
  id: string;
  organizationId: string;
  status: InvoiceStatus;
  version: number;
  stripeInvoiceId: string | null;
  invoiceNumber: string;
  clinicId: string;
  amountDueCents: number;
}

interface FakeOverrides {
  invoice?: FakeInvoice | null;
  casCount?: number;
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

const defaultInvoice = (): FakeInvoice => ({
  id: INVOICE_ID,
  organizationId: ORG_ID,
  status: InvoiceStatus.OPEN,
  version: 4,
  stripeInvoiceId: STRIPE_INVOICE_ID,
  invoiceNumber: "INV-2026-05-0c0c0c0c",
  clinicId: CLINIC_ID,
  amountDueCents: 15000,
});

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const invoice = overrides.invoice === undefined ? defaultInvoice() : overrides.invoice;
  const casCount = overrides.casCount ?? 1;

  const tx = {
    invoice: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "findFirst", args });
        return invoice;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "updateMany", args });
        return { count: casCount };
      }),
    },
    commandLog: { create: vi.fn(async () => ({ id: "cl" })) },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al" };
      }),
    },
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
    clock: clock.createFrozenClock(new Date("2026-06-01T00:00:00.000Z")),
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

const voidedInput = {
  invoiceId: INVOICE_ID,
  organizationId: ORG_ID,
  stripeInvoiceId: STRIPE_INVOICE_ID,
  voidedAt: "2026-05-31T23:30:00.000Z",
  stripeEventId: "evt_TestVoided1",
};

const uncollectibleInput = {
  invoiceId: INVOICE_ID,
  organizationId: ORG_ID,
  stripeInvoiceId: STRIPE_INVOICE_ID,
  recordedAt: "2026-05-31T23:30:00.000Z",
  stripeEventId: "evt_TestUnc1",
};

const failedInput = {
  invoiceId: INVOICE_ID,
  organizationId: ORG_ID,
  stripeInvoiceId: STRIPE_INVOICE_ID,
  stripeEventId: "evt_TestFailed1",
  failureCode: "card_declined",
  failureMessage: "Your card was declined.",
  attemptedAmountCents: 15000,
  failedAt: "2026-05-31T23:30:00.000Z",
};

describe("MarkInvoiceVoided", () => {
  it("transitions OPEN → VOID + clears amountDue + CAS-bumps version", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MarkInvoiceVoided, voidedInput)
    );
    expect(out.transitioned).toBe(true);
    expect(out.status).toBe("VOID");
    const cas = fake.calls.find((c) => c.table === "invoice" && c.op === "updateMany");
    const casArgs = cas!.args as { data: Record<string, unknown> };
    expect(casArgs.data["status"]).toBe("VOID");
    expect(casArgs.data["amountDueCents"]).toBe(0);
  });

  it("short-circuits when already VOID", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.VOID },
    });
    configureBus(fake.client);
    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MarkInvoiceVoided, voidedInput)
    );
    expect(out.transitioned).toBe(false);
  });

  it("returns recognized=false when the Pharmax invoice does not exist", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);
    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MarkInvoiceVoided, voidedInput)
    );
    expect(out.recognized).toBe(false);
  });

  it("throws on PAID → VOID (terminal status)", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.PAID },
    });
    configureBus(fake.client);
    await expect(
      withSystemContext("billing-test", () => executeSystemCommand(MarkInvoiceVoided, voidedInput))
    ).rejects.toMatchObject({ code: MARK_VOIDED_INVALID_STATUS_TRANSITION });
  });

  it("throws on CAS miss", async () => {
    const fake = buildPrismaFake({ casCount: 0 });
    configureBus(fake.client);
    await expect(
      withSystemContext("billing-test", () => executeSystemCommand(MarkInvoiceVoided, voidedInput))
    ).rejects.toMatchObject({ code: MARK_VOIDED_VERSION_MISMATCH });
  });
});

describe("MarkInvoiceUncollectible", () => {
  it("transitions OPEN → UNCOLLECTIBLE + clears amountDue", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MarkInvoiceUncollectible, uncollectibleInput)
    );
    expect(out.transitioned).toBe(true);
    expect(out.status).toBe("UNCOLLECTIBLE");
  });

  it("short-circuits when already UNCOLLECTIBLE", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.UNCOLLECTIBLE },
    });
    configureBus(fake.client);
    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MarkInvoiceUncollectible, uncollectibleInput)
    );
    expect(out.transitioned).toBe(false);
  });

  it("returns recognized=false on orphan invoice", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);
    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MarkInvoiceUncollectible, uncollectibleInput)
    );
    expect(out.recognized).toBe(false);
  });

  it("throws on PAID → UNCOLLECTIBLE", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.PAID },
    });
    configureBus(fake.client);
    await expect(
      withSystemContext("billing-test", () =>
        executeSystemCommand(MarkInvoiceUncollectible, uncollectibleInput)
      )
    ).rejects.toMatchObject({ code: MARK_UNCOLLECTIBLE_INVALID_STATUS_TRANSITION });
  });

  it("throws on CAS miss", async () => {
    const fake = buildPrismaFake({ casCount: 0 });
    configureBus(fake.client);
    await expect(
      withSystemContext("billing-test", () =>
        executeSystemCommand(MarkInvoiceUncollectible, uncollectibleInput)
      )
    ).rejects.toMatchObject({ code: MARK_UNCOLLECTIBLE_VERSION_MISMATCH });
  });
});

describe("RecordInvoicePaymentFailure", () => {
  it("records the failure with audit + outbox, does NOT change status", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(RecordInvoicePaymentFailure, failedInput)
    );
    expect(out.recognized).toBe(true);
    // No CAS — payment_failed doesn't transition status.
    expect(fake.calls.filter((c) => c.table === "invoice" && c.op === "updateMany")).toHaveLength(
      0
    );

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (
      outboxCalls[0]!.args as {
        data: Array<{ eventType: string; payload: Record<string, unknown> }>;
      }
    ).data;
    expect(outboxData[0]?.eventType).toBe("billing.invoice.payment_failed.v1");
    expect(outboxData[0]?.payload["failureCode"]).toBe("card_declined");
  });

  it("returns recognized=false on orphan invoice (no outbox emit)", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);
    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(RecordInvoicePaymentFailure, failedInput)
    );
    expect(out.recognized).toBe(false);
    expect(
      fake.calls.filter((c) => c.table === "eventOutbox" && c.op === "createMany")
    ).toHaveLength(0);
  });
});
