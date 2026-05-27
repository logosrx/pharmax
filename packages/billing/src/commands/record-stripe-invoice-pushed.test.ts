// RecordStripeInvoicePushed contract tests.
//
// Surface:
//   - First-link happy path: writes stripeInvoiceId, stripeCustomerId;
//     emits `billing.invoice.stripe_pushed.v1`.
//   - Idempotent re-write with SAME stripeInvoiceId: no mutation,
//     audit-only "skipped" row, no outbox emit.
//   - Mismatched stripeInvoiceId re-write: typed RECORD_STRIPE_PUSH_MISMATCH.
//   - Cross-tenant invoice: RECORD_STRIPE_PUSH_INVOICE_NOT_FOUND.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { clock, logger } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

import {
  RECORD_STRIPE_PUSH_INVOICE_NOT_FOUND,
  RECORD_STRIPE_PUSH_MISMATCH,
  RecordStripeInvoicePushed,
} from "./record-stripe-invoice-pushed.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";

interface FakeOverrides {
  invoice?: { id: string; stripeInvoiceId: string | null } | null;
}

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const invoice =
    overrides.invoice === undefined ? { id: INVOICE_ID, stripeInvoiceId: null } : overrides.invoice;

  const tx = {
    invoice: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "findFirst", args });
        return invoice;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "update", args });
        return { id: INVOICE_ID };
      }),
    },
    commandLog: { create: vi.fn(async () => ({ id: "cl-1" })) },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al-1" };
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
    clock: clock.createFrozenClock(new Date("2026-05-31T21:00:00.000Z")),
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
  organizationId: ORG_ID,
  invoiceId: INVOICE_ID,
  stripeInvoiceId: "in_1NewStripeInvoice",
  stripeCustomerId: "cus_1Acme",
  stripeStatus: "open" as const,
  hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_xxx/test_yyy",
};

describe("RecordStripeInvoicePushed — first link", () => {
  it("writes stripeInvoiceId + stripeCustomerId and emits the v1 event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(RecordStripeInvoicePushed, validInput)
    );

    expect(out.firstLink).toBe(true);
    expect(out.stripeInvoiceId).toBe(validInput.stripeInvoiceId);

    const update = fake.calls.find((c) => c.table === "invoice" && c.op === "update");
    const updateData = (update!.args as { data: Record<string, unknown> }).data;
    expect(updateData["stripeInvoiceId"]).toBe(validInput.stripeInvoiceId);
    expect(updateData["stripeCustomerId"]).toBe(validInput.stripeCustomerId);

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (outboxCalls[0]!.args as { data: Array<{ eventType: string }> }).data;
    expect(outboxData[0]?.eventType).toBe("billing.invoice.stripe_pushed.v1");
  });
});

describe("RecordStripeInvoicePushed — idempotency", () => {
  it("no-ops when the invoice is already linked to the SAME stripeInvoiceId", async () => {
    const fake = buildPrismaFake({
      invoice: { id: INVOICE_ID, stripeInvoiceId: validInput.stripeInvoiceId },
    });
    configureBus(fake.client);

    const out = await withSystemContext("billing-test", () =>
      executeSystemCommand(RecordStripeInvoicePushed, validInput)
    );

    expect(out.firstLink).toBe(false);
    expect(fake.calls.filter((c) => c.table === "invoice" && c.op === "update")).toHaveLength(0);
    expect(
      fake.calls.filter((c) => c.table === "eventOutbox" && c.op === "createMany")
    ).toHaveLength(0);
  });

  it("throws RECORD_STRIPE_PUSH_MISMATCH when linked to a DIFFERENT stripeInvoiceId", async () => {
    const fake = buildPrismaFake({
      invoice: { id: INVOICE_ID, stripeInvoiceId: "in_OtherInvoice" },
    });
    configureBus(fake.client);

    await expect(
      withSystemContext("billing-test", () =>
        executeSystemCommand(RecordStripeInvoicePushed, validInput)
      )
    ).rejects.toMatchObject({ code: RECORD_STRIPE_PUSH_MISMATCH });
  });
});

describe("RecordStripeInvoicePushed — guards", () => {
  it("rejects when the invoice is not in the target org", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);

    await expect(
      withSystemContext("billing-test", () =>
        executeSystemCommand(RecordStripeInvoicePushed, validInput)
      )
    ).rejects.toMatchObject({ code: RECORD_STRIPE_PUSH_INVOICE_NOT_FOUND });
  });
});
