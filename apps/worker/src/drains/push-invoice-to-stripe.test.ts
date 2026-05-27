// Unit tests for the finalized-invoice → Stripe push outbox handler.
// The Stripe SDK is hidden behind the `StripeInvoicePort` interface
// so the test injects a deterministic stub.

import { configureCommandBus, resetCommandBusConfigurationForTests } from "@pharmax/command-bus";
import {
  type StripeInvoicePort,
  type StripePushRequest,
  type StripePushResult,
} from "@pharmax/billing";
import { clock, logger as loggerNs } from "@pharmax/platform-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPushInvoiceToStripeHandler } from "./push-invoice-to-stripe.js";
import type { ClaimedOutboxEventRow } from "./row-types.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";

interface BuildClientInput {
  stripeCustomer: { stripeCustomerId: string; organizationId: string } | null;
  invoiceLines: ReadonlyArray<{
    id: string;
    description: string;
    quantity: number;
    unitAmountCents: number;
    amountCents: number;
  }>;
  issuedAt?: Date;
  dueAt?: Date;
}

function buildPrismaFake(input: BuildClientInput) {
  const invoiceUpdate = vi.fn(async () => ({ id: INVOICE_ID }));

  const tx = {
    invoice: {
      findFirst: vi.fn(async () => ({ id: INVOICE_ID, stripeInvoiceId: null })),
      update: invoiceUpdate,
    },
    commandLog: { create: vi.fn(async () => ({ id: "cl-1" })) },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
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
    stripeCustomer: { findUnique: vi.fn(async () => input.stripeCustomer) },
    invoice: {
      findUnique: vi.fn(async () => ({
        issuedAt: input.issuedAt ?? new Date("2026-05-31T20:00:00.000Z"),
        dueAt: input.dueAt ?? new Date("2026-06-30T20:00:00.000Z"),
        lines: input.invoiceLines,
      })),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, invoiceUpdate };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-05-31T21:00:00.000Z")),
    logger: loggerNs.noopLogger,
  });
}

function buildRow(payload: Record<string, unknown>): ClaimedOutboxEventRow {
  return {
    id: "outbox-finalized-1",
    organizationId: ORG_ID,
    eventType: "billing.invoice.finalized.v1",
    aggregateType: "Invoice",
    aggregateId: INVOICE_ID,
    payload,
    attempts: 1,
    occurredAt: new Date("2026-05-31T20:00:00.000Z"),
  } as unknown as ClaimedOutboxEventRow;
}

const HANDLER_CTX = { logger: loggerNs.noopLogger, receivedAt: new Date() };

const FINALIZED_PAYLOAD = {
  organizationId: ORG_ID,
  clinicId: CLINIC_ID,
  invoiceId: INVOICE_ID,
  invoiceNumber: "INV-2026-05-0c0c0c0c",
  currency: "usd",
  subtotalCents: 15000,
  totalCents: 15000,
  amountDueCents: 15000,
  lineCount: 3,
  issuedAt: "2026-05-31T20:00:00.000Z",
  dueAt: "2026-06-30T20:00:00.000Z",
  occurredAt: "2026-05-31T20:00:00.000Z",
};

function stubPort(result?: StripePushResult): StripeInvoicePort & {
  calls: StripePushRequest[];
} {
  const calls: StripePushRequest[] = [];
  const port: StripeInvoicePort = {
    async pushInvoice(req) {
      calls.push(req);
      return (
        result ?? {
          stripeInvoiceId: "in_TEST",
          stripeStatus: "open",
          hostedInvoiceUrl: "https://invoice.stripe.com/x",
        }
      );
    },
  };
  return Object.assign(port, { calls });
}

beforeEach(() => {
  const fake = buildPrismaFake({
    stripeCustomer: { stripeCustomerId: "cus_Acme", organizationId: ORG_ID },
    invoiceLines: [
      {
        id: "2222bbbb-2222-4222-8222-000000000001",
        description: "Shipped prescription order (dispense fee)",
        quantity: 1,
        unitAmountCents: 5000,
        amountCents: 5000,
      },
    ],
  });
  configureBus(fake.client);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

describe("createPushInvoiceToStripeHandler — happy path", () => {
  it("pushes the finalized invoice to Stripe and writes the linkage back", async () => {
    const fake = buildPrismaFake({
      stripeCustomer: { stripeCustomerId: "cus_Acme", organizationId: ORG_ID },
      invoiceLines: [
        {
          id: "2222bbbb-2222-4222-8222-000000000001",
          description: "Shipped prescription order (dispense fee)",
          quantity: 1,
          unitAmountCents: 5000,
          amountCents: 5000,
        },
        {
          id: "2222bbbb-2222-4222-8222-000000000002",
          description: "Shipped prescription order (dispense fee)",
          quantity: 1,
          unitAmountCents: 5000,
          amountCents: 5000,
        },
      ],
    });
    configureBus(fake.client);

    const port = stubPort();
    const handler = createPushInvoiceToStripeHandler({
      client: fake.client as never,
      stripePort: port,
    });

    await handler(buildRow(FINALIZED_PAYLOAD), HANDLER_CTX);

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({
      pharmaxInvoiceId: INVOICE_ID,
      stripeCustomerId: "cus_Acme",
      currency: "usd",
      daysUntilDue: 30,
    });
    expect(port.calls[0]?.lines).toHaveLength(2);

    // Linkage written back via RecordStripeInvoicePushed → invoice.update.
    expect(fake.invoiceUpdate).toHaveBeenCalledTimes(1);
    const updateData = (
      fake.invoiceUpdate.mock.calls[0] as unknown as Array<{ data: Record<string, unknown> }>
    )[0]!.data;
    expect(updateData["stripeInvoiceId"]).toBe("in_TEST");
    expect(updateData["stripeCustomerId"]).toBe("cus_Acme");
  });
});

describe("createPushInvoiceToStripeHandler — disabled / null port", () => {
  it("no-ops cleanly when stripePort is null (STRIPE_SECRET_KEY unset)", async () => {
    const fake = buildPrismaFake({
      stripeCustomer: { stripeCustomerId: "cus_Acme", organizationId: ORG_ID },
      invoiceLines: [
        {
          id: "x",
          description: "x",
          quantity: 1,
          unitAmountCents: 5000,
          amountCents: 5000,
        },
      ],
    });
    configureBus(fake.client);

    const handler = createPushInvoiceToStripeHandler({
      client: fake.client as never,
      stripePort: null,
    });

    await handler(buildRow(FINALIZED_PAYLOAD), HANDLER_CTX);

    // No invoice mutation, no port call, no error.
    expect(fake.invoiceUpdate).not.toHaveBeenCalled();
  });
});

describe("createPushInvoiceToStripeHandler — guards", () => {
  it("throws STRIPE_PUSH_CUSTOMER_NOT_LINKED when no StripeCustomer exists for the clinic", async () => {
    const fake = buildPrismaFake({
      stripeCustomer: null,
      invoiceLines: [
        {
          id: "x",
          description: "x",
          quantity: 1,
          unitAmountCents: 5000,
          amountCents: 5000,
        },
      ],
    });
    configureBus(fake.client);

    const port = stubPort();
    const handler = createPushInvoiceToStripeHandler({
      client: fake.client as never,
      stripePort: port,
    });

    await expect(handler(buildRow(FINALIZED_PAYLOAD), HANDLER_CTX)).rejects.toMatchObject({
      code: "STRIPE_PUSH_CUSTOMER_NOT_LINKED",
    });
    expect(port.calls).toHaveLength(0);
  });

  it("throws when the payload is missing required fields", async () => {
    const fake = buildPrismaFake({
      stripeCustomer: { stripeCustomerId: "cus_Acme", organizationId: ORG_ID },
      invoiceLines: [],
    });
    configureBus(fake.client);

    const port = stubPort();
    const handler = createPushInvoiceToStripeHandler({
      client: fake.client as never,
      stripePort: port,
    });

    await expect(
      handler(buildRow({ organizationId: ORG_ID /* missing the rest */ }), HANDLER_CTX)
    ).rejects.toMatchObject({ code: "STRIPE_PUSH_HANDLER_PAYLOAD_INCOMPLETE" });
  });
});
