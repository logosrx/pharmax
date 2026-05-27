// MarkInvoicePaid contract tests.
//
// Covers:
//   - OPEN → PAID happy path: amounts written, CAS bumps version,
//     emits `billing.invoice.paid.v1`.
//   - Already-PAID re-delivery: short-circuits with transitioned=false,
//     no version bump, no outbox emit.
//   - Orphan invoice (lookup miss): recognized=false, audit-only row,
//     no outbox emit, no throw — Stripe retries should not loop.
//   - VOID / UNCOLLECTIBLE → throws MARK_PAID_INVALID_STATUS_TRANSITION
//     (Stripe ordering bug).
//   - Mismatched stripeInvoiceId: throws MARK_PAID_STRIPE_INVOICE_MISMATCH.
//   - CAS miss: MARK_PAID_VERSION_MISMATCH.
//   - Partial payment: amountDueCents > 0 residual.

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
  MARK_PAID_INVALID_STATUS_TRANSITION,
  MARK_PAID_VERSION_MISMATCH,
  MarkInvoicePaid,
} from "./mark-invoice-paid.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const STRIPE_INVOICE_ID = "in_TestStripeInvoice";

interface FakeInvoice {
  id: string;
  organizationId: string;
  status: InvoiceStatus;
  totalCents: number;
  amountPaidCents: number;
  version: number;
  stripeInvoiceId: string | null;
  invoiceNumber: string;
  clinicId: string;
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
  totalCents: 15000,
  amountPaidCents: 0,
  version: 4,
  stripeInvoiceId: STRIPE_INVOICE_ID,
  invoiceNumber: "INV-2026-05-0c0c0c0c",
  clinicId: CLINIC_ID,
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

const validInput = {
  invoiceId: INVOICE_ID,
  organizationId: ORG_ID,
  stripeInvoiceId: STRIPE_INVOICE_ID,
  amountPaidCents: 15000,
  paidAt: "2026-05-31T23:00:00.000Z",
  stripeEventId: "evt_TestPaid1",
};

describe("MarkInvoicePaid — happy path", () => {
  it("transitions OPEN → PAID, writes amounts, CAS-bumps version, emits the v1 event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MarkInvoicePaid, validInput)
    );

    expect(out.transitioned).toBe(true);
    expect(out.recognized).toBe(true);
    expect(out.status).toBe("PAID");
    expect(out.amountPaidCents).toBe(15000);
    expect(out.version).toBe(5);

    const cas = fake.calls.find((c) => c.table === "invoice" && c.op === "updateMany");
    const casArgs = cas!.args as {
      where: { id: string; version: number };
      data: Record<string, unknown>;
    };
    expect(casArgs.where.version).toBe(4);
    expect(casArgs.data["status"]).toBe("PAID");
    expect(casArgs.data["amountPaidCents"]).toBe(15000);
    expect(casArgs.data["amountDueCents"]).toBe(0);
    expect(casArgs.data["version"]).toBe(5);

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (
      outboxCalls[0]!.args as {
        data: Array<{ eventType: string; payload: Record<string, unknown> }>;
      }
    ).data;
    expect(outboxData[0]?.eventType).toBe("billing.invoice.paid.v1");
  });

  it("computes residualDueCents when Stripe collected less than totalCents", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withSystemContext("billing-test", () =>
      executeSystemCommand(MarkInvoicePaid, {
        ...validInput,
        amountPaidCents: 10000, // partial — leaves 5000 residual
      })
    );

    const cas = fake.calls.find((c) => c.table === "invoice" && c.op === "updateMany");
    const casArgs = cas!.args as { data: Record<string, unknown> };
    expect(casArgs.data["amountDueCents"]).toBe(5000);
  });
});

describe("MarkInvoicePaid — idempotency", () => {
  it("short-circuits when invoice is already PAID", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.PAID, amountPaidCents: 15000 },
    });
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MarkInvoicePaid, validInput)
    );

    expect(out.transitioned).toBe(false);
    expect(out.recognized).toBe(true);
    expect(fake.calls.filter((c) => c.table === "invoice" && c.op === "updateMany")).toHaveLength(
      0
    );
    expect(
      fake.calls.filter((c) => c.table === "eventOutbox" && c.op === "createMany")
    ).toHaveLength(0);
  });

  it("returns recognized=false (no throw) when the Pharmax invoice does not exist", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(MarkInvoicePaid, validInput)
    );

    expect(out.recognized).toBe(false);
    expect(out.transitioned).toBe(false);
    expect(
      fake.calls.filter((c) => c.table === "eventOutbox" && c.op === "createMany")
    ).toHaveLength(0);
  });
});

describe("MarkInvoicePaid — guards", () => {
  it("throws on VOID → PAID (Stripe ordering bug)", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.VOID },
    });
    configureBus(fake.client);

    await expect(
      withSystemContext("billing-test", () => executeSystemCommand(MarkInvoicePaid, validInput))
    ).rejects.toMatchObject({ code: MARK_PAID_INVALID_STATUS_TRANSITION });
  });

  it("throws on UNCOLLECTIBLE → PAID", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.UNCOLLECTIBLE },
    });
    configureBus(fake.client);

    await expect(
      withSystemContext("billing-test", () => executeSystemCommand(MarkInvoicePaid, validInput))
    ).rejects.toMatchObject({ code: MARK_PAID_INVALID_STATUS_TRANSITION });
  });

  it("throws MARK_PAID_STRIPE_INVOICE_MISMATCH when linked to a DIFFERENT Stripe invoice", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), stripeInvoiceId: "in_OtherStripeInvoice" },
    });
    configureBus(fake.client);

    await expect(
      withSystemContext("billing-test", () => executeSystemCommand(MarkInvoicePaid, validInput))
    ).rejects.toMatchObject({ code: "MARK_PAID_STRIPE_INVOICE_MISMATCH" });
  });

  it("throws MARK_PAID_VERSION_MISMATCH on CAS miss", async () => {
    const fake = buildPrismaFake({ casCount: 0 });
    configureBus(fake.client);

    await expect(
      withSystemContext("billing-test", () => executeSystemCommand(MarkInvoicePaid, validInput))
    ).rejects.toMatchObject({ code: MARK_PAID_VERSION_MISMATCH });
  });
});
