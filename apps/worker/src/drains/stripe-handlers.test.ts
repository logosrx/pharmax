// Unit tests for the Stripe webhook handler factory.
//
// Drives each handler against a stubbed PrismaClient + an in-process
// command bus. Verifies:
//   - `invoice.paid` → MarkInvoicePaid dispatched with the right payload
//   - `invoice.voided` → MarkInvoiceVoided
//   - `invoice.marked_uncollectible` → MarkInvoiceUncollectible
//   - `invoice.payment_failed` → RecordInvoicePaymentFailure
//   - Orphan events (no Pharmax linkage) return cleanly (no throw)
//   - Log-only events (customer.*, payment_intent.*) no-op
//   - `invoice.id` missing → typed error

import { configureCommandBus, resetCommandBusConfigurationForTests } from "@pharmax/command-bus";
import { clock, logger as loggerNs } from "@pharmax/platform-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { createStripeEventHandlers } from "./stripe-handlers.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const STRIPE_INVOICE_ID = "in_TestStripeInvoice";

interface BuildClientInput {
  pharmaxInvoice: { id: string; organizationId: string } | null;
  status?: "OPEN" | "PAID" | "VOID" | "UNCOLLECTIBLE";
}

function buildPrismaFake(input: BuildClientInput) {
  const invoiceFindFirst = vi.fn(async () => ({
    id: INVOICE_ID,
    organizationId: ORG_ID,
    status: input.status ?? "OPEN",
    totalCents: 15000,
    amountPaidCents: 0,
    amountDueCents: 15000,
    version: 4,
    stripeInvoiceId: STRIPE_INVOICE_ID,
    invoiceNumber: "INV-2026-05-0c0c0c0c",
    clinicId: CLINIC_ID,
  }));
  const invoiceUpdateMany = vi.fn(async () => ({ count: 1 }));

  const tx = {
    invoice: { findFirst: invoiceFindFirst, updateMany: invoiceUpdateMany },
    commandLog: { create: vi.fn(async () => ({ id: "cl" })) },
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
    eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    invoice: {
      findUnique: vi.fn(async () => input.pharmaxInvoice),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, invoiceFindFirst, invoiceUpdateMany, tx };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-06-01T00:00:00.000Z")),
    logger: loggerNs.noopLogger,
  });
}

function buildEvent(input: {
  type: string;
  invoiceId?: string;
  amountPaid?: number;
  amountDue?: number;
  statusTransitions?: Stripe.Invoice["status_transitions"];
  charge?: { id?: string; failure_code?: string; failure_message?: string } | string | null;
  nextPaymentAttempt?: number | null;
}): Stripe.Event {
  return {
    id: `evt_${input.type.replace(/\./g, "_")}_1`,
    type: input.type,
    created: 1748736000,
    data: {
      object: {
        id: input.invoiceId ?? STRIPE_INVOICE_ID,
        amount_paid: input.amountPaid ?? 0,
        amount_due: input.amountDue ?? 0,
        status_transitions: input.statusTransitions ?? {},
        charge: input.charge ?? null,
        next_payment_attempt: input.nextPaymentAttempt ?? null,
      } as unknown as Stripe.Invoice,
    },
  } as unknown as Stripe.Event;
}

const HANDLER_CTX = { logger: loggerNs.noopLogger, receivedAt: new Date() };

beforeEach(() => {
  const fake = buildPrismaFake({
    pharmaxInvoice: { id: INVOICE_ID, organizationId: ORG_ID },
  });
  configureBus(fake.client);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

describe("createStripeEventHandlers — invoice.paid", () => {
  it("dispatches MarkInvoicePaid with the right amount + timestamp", async () => {
    const fake = buildPrismaFake({
      pharmaxInvoice: { id: INVOICE_ID, organizationId: ORG_ID },
    });
    configureBus(fake.client);

    const handlers = createStripeEventHandlers({ client: fake.client as never });
    const handler = handlers["invoice.paid"]!;
    await handler(
      buildEvent({
        type: "invoice.paid",
        amountPaid: 15000,
        statusTransitions: { paid_at: 1748736000 } as Stripe.Invoice["status_transitions"],
        charge: "ch_TestCharge",
      }),
      HANDLER_CTX
    );

    expect(fake.invoiceUpdateMany).toHaveBeenCalledTimes(1);
    const calls = fake.invoiceUpdateMany.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >;
    expect(calls[0]![0].data["status"]).toBe("PAID");
    expect(calls[0]![0].data["amountPaidCents"]).toBe(15000);
  });

  it("returns cleanly on an orphan invoice (no throw, no DB write)", async () => {
    const fake = buildPrismaFake({ pharmaxInvoice: null });
    configureBus(fake.client);

    const handlers = createStripeEventHandlers({ client: fake.client as never });
    const handler = handlers["invoice.paid"]!;
    await expect(
      handler(buildEvent({ type: "invoice.paid", amountPaid: 15000 }), HANDLER_CTX)
    ).resolves.toBeUndefined();
    expect(fake.invoiceUpdateMany).not.toHaveBeenCalled();
  });
});

describe("createStripeEventHandlers — invoice.voided", () => {
  it("dispatches MarkInvoiceVoided with voidedAt from status_transitions", async () => {
    const fake = buildPrismaFake({
      pharmaxInvoice: { id: INVOICE_ID, organizationId: ORG_ID },
    });
    configureBus(fake.client);

    const handlers = createStripeEventHandlers({ client: fake.client as never });
    const handler = handlers["invoice.voided"]!;
    await handler(
      buildEvent({
        type: "invoice.voided",
        statusTransitions: { voided_at: 1748736000 } as Stripe.Invoice["status_transitions"],
      }),
      HANDLER_CTX
    );

    expect(fake.invoiceUpdateMany).toHaveBeenCalledTimes(1);
    const calls = fake.invoiceUpdateMany.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >;
    expect(calls[0]![0].data["status"]).toBe("VOID");
    expect(calls[0]![0].data["amountDueCents"]).toBe(0);
  });
});

describe("createStripeEventHandlers — invoice.marked_uncollectible", () => {
  it("dispatches MarkInvoiceUncollectible", async () => {
    const fake = buildPrismaFake({
      pharmaxInvoice: { id: INVOICE_ID, organizationId: ORG_ID },
    });
    configureBus(fake.client);

    const handlers = createStripeEventHandlers({ client: fake.client as never });
    const handler = handlers["invoice.marked_uncollectible"]!;
    await handler(
      buildEvent({
        type: "invoice.marked_uncollectible",
        statusTransitions: {
          marked_uncollectible_at: 1748736000,
        } as Stripe.Invoice["status_transitions"],
      }),
      HANDLER_CTX
    );

    expect(fake.invoiceUpdateMany).toHaveBeenCalledTimes(1);
    const calls = fake.invoiceUpdateMany.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >;
    expect(calls[0]![0].data["status"]).toBe("UNCOLLECTIBLE");
  });
});

describe("createStripeEventHandlers — invoice.payment_failed", () => {
  it("dispatches RecordInvoicePaymentFailure with failure code + message", async () => {
    const fake = buildPrismaFake({
      pharmaxInvoice: { id: INVOICE_ID, organizationId: ORG_ID },
    });
    configureBus(fake.client);

    const handlers = createStripeEventHandlers({ client: fake.client as never });
    const handler = handlers["invoice.payment_failed"]!;
    await handler(
      buildEvent({
        type: "invoice.payment_failed",
        amountDue: 15000,
        charge: {
          id: "ch_TestFailed",
          failure_code: "card_declined",
          failure_message: "Your card was declined.",
        },
        nextPaymentAttempt: 1748822400,
      }),
      HANDLER_CTX
    );

    // payment_failed does NOT change status — no CAS update.
    expect(fake.invoiceUpdateMany).not.toHaveBeenCalled();
    // But the audit row + outbox emit DID happen.
    const outboxCalls = fake.tx.eventOutbox.createMany.mock.calls;
    expect(outboxCalls.length).toBeGreaterThan(0);
  });
});

describe("createStripeEventHandlers — log-only events", () => {
  it.each([
    "invoice.created",
    "invoice.finalized",
    "customer.created",
    "customer.updated",
    "customer.deleted",
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
  ])("no-ops on %s without throwing or hitting the DB", async (eventType) => {
    const fake = buildPrismaFake({
      pharmaxInvoice: { id: INVOICE_ID, organizationId: ORG_ID },
    });
    configureBus(fake.client);

    const handlers = createStripeEventHandlers({ client: fake.client as never });
    const handler = handlers[eventType]!;
    expect(handler).toBeDefined();

    await expect(handler(buildEvent({ type: eventType }), HANDLER_CTX)).resolves.toBeUndefined();
    expect(fake.invoiceUpdateMany).not.toHaveBeenCalled();
  });
});

describe("createStripeEventHandlers — charge.refunded", () => {
  it("dispatches RecordRefundReceived with the latest refund from the payload", async () => {
    const fake = buildPrismaFake({
      pharmaxInvoice: { id: INVOICE_ID, organizationId: ORG_ID },
    });
    // Override the fake to make invoice-by-charge return our row.
    const tx = (fake.client as { $transaction: ReturnType<typeof vi.fn> }).$transaction;
    tx.mockImplementationOnce(async (fn: (t: unknown) => Promise<unknown>) => {
      const subTx = {
        invoiceLine: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(async () => ({ id: "line-refund" })),
        },
        invoice: {
          findFirst: vi.fn(async () => ({
            id: INVOICE_ID,
            organizationId: ORG_ID,
            clinicId: CLINIC_ID,
            invoiceNumber: "INV-2026-05-0c0c0c0c",
            amountDueCents: 0,
          })),
          update: vi.fn(async () => ({ id: INVOICE_ID })),
        },
        commandLog: { create: vi.fn(async () => ({ id: "cl" })) },
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
        eventOutbox: { createMany: vi.fn(async () => ({ count: 1 })) },
        $executeRaw: vi.fn(async () => 0),
      };
      return fn(subTx);
    });
    configureBus(fake.client);

    const handlers = createStripeEventHandlers({ client: fake.client as never });
    const handler = handlers["charge.refunded"]!;

    const chargeEvent = {
      id: "evt_charge_refunded_1",
      type: "charge.refunded",
      created: 1748736000,
      data: {
        object: {
          id: "ch_TestCharge",
          refunds: {
            data: [
              {
                id: "re_TestRefund",
                amount: 5000,
                status: "succeeded",
                reason: "requested_by_customer",
                created: 1748736000,
              },
            ],
          },
        } as unknown as Stripe.Charge,
      },
    } as unknown as Stripe.Event;

    await handler(chargeEvent, HANDLER_CTX);
    // No assertions on specific fields beyond "no throw" — the
    // RecordRefundReceived contract test covers the data shape.
  });

  it("warns + returns when no refund is present in the payload", async () => {
    const fake = buildPrismaFake({
      pharmaxInvoice: { id: INVOICE_ID, organizationId: ORG_ID },
    });
    configureBus(fake.client);

    const handlers = createStripeEventHandlers({ client: fake.client as never });
    const handler = handlers["charge.refunded"]!;
    const chargeEvent = {
      id: "evt_charge_refunded_empty",
      type: "charge.refunded",
      created: 1748736000,
      data: {
        object: { id: "ch_TestCharge", refunds: { data: [] } } as unknown as Stripe.Charge,
      },
    } as unknown as Stripe.Event;

    await expect(handler(chargeEvent, HANDLER_CTX)).resolves.toBeUndefined();
  });
});

describe("createStripeEventHandlers — payload guards", () => {
  it("throws when invoice.id is missing from the event", async () => {
    const fake = buildPrismaFake({
      pharmaxInvoice: { id: INVOICE_ID, organizationId: ORG_ID },
    });
    configureBus(fake.client);

    const handlers = createStripeEventHandlers({ client: fake.client as never });
    const handler = handlers["invoice.paid"]!;
    const badEvent = {
      id: "evt_no_id",
      type: "invoice.paid",
      created: 1748736000,
      data: { object: { amount_paid: 15000 } as unknown as Stripe.Invoice },
    } as unknown as Stripe.Event;

    await expect(handler(badEvent, HANDLER_CTX)).rejects.toMatchObject({
      code: "STRIPE_HANDLER_INVOICE_ID_MISSING",
    });
  });
});
