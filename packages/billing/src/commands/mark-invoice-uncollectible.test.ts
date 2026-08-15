// MarkInvoiceUncollectible contract tests.
//
// Sibling of MarkInvoiceVoided, with one behaviour the void path does
// not have: the balance being written off is captured BEFORE the row
// is zeroed and carried into the audit row and the event. That number
// is the write-off, so most of this file is about it landing intact.
//
// Surface:
//   - Transition: OPEN → UNCOLLECTIBLE, amountDue zeroed, the
//     pre-zero balance published as residualWriteOffCents.
//   - Redelivery: already-UNCOLLECTIBLE is a total no-op.
//   - State guards: PAID and VOID are refused.
//   - Tenancy: the lookup is scoped by organizationId.
//   - Stripe linkage: mismatched link refused, absent link backfilled.
//   - Concurrency: CAS miss surfaces the version mismatch.
//   - Evidence: audit action + `billing.invoice.uncollectible.v1`.

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

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const STRIPE_INVOICE_ID = "in_TestStripeInvoice";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const RECORDED_AT = "2026-05-31T23:30:00.000Z";
const OPEN_BALANCE_CENTS = 15_000;

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
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

const defaultInvoice = (): FakeInvoice => ({
  id: INVOICE_ID,
  organizationId: ORG_ID,
  status: InvoiceStatus.OPEN,
  version: 4,
  stripeInvoiceId: STRIPE_INVOICE_ID,
  invoiceNumber: "INV-2026-05-0c0c0c0c",
  clinicId: CLINIC_ID,
  amountDueCents: OPEN_BALANCE_CENTS,
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
    clock: clock.createFrozenClock(NOW),
    logger: logger.noopLogger,
  });
}

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function casDataOf(calls: FakeCall[]): Record<string, unknown> {
  const cas = callsOf(calls, "invoice", "updateMany")[0];
  if (cas === undefined) throw new Error("expected an invoice CAS update");
  return (cas.args as { data: Record<string, unknown> }).data;
}

function auditDataOf(calls: FakeCall[]): { action: string; metadata: Record<string, unknown> } {
  const audit = callsOf(calls, "auditLog", "create")[0];
  if (audit === undefined) throw new Error("expected an audit row");
  return (audit.args as { data: { action: string; metadata: Record<string, unknown> } }).data;
}

function outboxRowsOf(
  calls: FakeCall[]
): Array<{ eventType: string; payload: Record<string, unknown> }> {
  return callsOf(calls, "eventOutbox", "createMany").flatMap(
    (c) => (c.args as { data: Array<{ eventType: string; payload: Record<string, unknown> }> }).data
  );
}

const validInput = {
  invoiceId: INVOICE_ID,
  organizationId: ORG_ID,
  stripeInvoiceId: STRIPE_INVOICE_ID,
  recordedAt: RECORDED_AT,
  stripeEventId: "evt_TestUncollectible1",
};

const run = (input: unknown = validInput, idempotencyKey?: string) =>
  withSystemContext("billing-test", () =>
    idempotencyKey === undefined
      ? executeSystemCommand(MarkInvoiceUncollectible, input)
      : executeSystemCommand(MarkInvoiceUncollectible, input, { idempotencyKey })
  );

beforeEach(() => {
  const fake = buildPrismaFake();
  configureBus(fake.client);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

describe("MarkInvoiceUncollectible — the write-off amount", () => {
  it("publishes the balance as it stood BEFORE the row was zeroed", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    // This is the whole write-off. The handler reads amountDueCents
    // from the row it loaded and only then clears it; if that order
    // ever inverted, every write-off would be reported as $0.00 and
    // bad debt would disappear from the books entirely.
    expect(casDataOf(fake.calls)["amountDueCents"]).toBe(0);
    expect(auditDataOf(fake.calls).metadata["residualWriteOffCents"]).toBe(OPEN_BALANCE_CENTS);
    expect(outboxRowsOf(fake.calls)[0]?.payload["residualWriteOffCents"]).toBe(OPEN_BALANCE_CENTS);
  });

  it("keeps the write-off a non-negative integer count of cents", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), amountDueCents: 12_345 },
    });
    configureBus(fake.client);

    await run();

    // Cents are integers end to end. A float here would round in the
    // ledger and the two sides would stop reconciling by pennies.
    const residual = auditDataOf(fake.calls).metadata["residualWriteOffCents"];
    expect(residual).toBe(12_345);
    expect(Number.isInteger(residual)).toBe(true);
    expect(residual as number).toBeGreaterThanOrEqual(0);
  });

  it("writes off zero — not null — for an invoice with nothing outstanding", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), amountDueCents: 0 },
    });
    configureBus(fake.client);

    await run();

    // A settled-but-uncollectible row must still report a number.
    // `null` would read downstream as "unknown write-off" and drop
    // the invoice out of aggregate write-off totals.
    expect(outboxRowsOf(fake.calls)[0]?.payload["residualWriteOffCents"]).toBe(0);
  });

  it("leaves the recorded totals alone while clearing the balance", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    const data = casDataOf(fake.calls);
    expect(data["status"]).toBe("UNCOLLECTIBLE");
    expect(data["amountDueCents"]).toBe(0);
    expect(data).not.toHaveProperty("subtotalCents");
    expect(data).not.toHaveProperty("totalCents");
  });

  it("advances the version by exactly one against the observed row", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await run();

    const cas = callsOf(fake.calls, "invoice", "updateMany")[0];
    const args = cas!.args as { where: { id: string; version: number }; data: { version: number } };
    expect(args.where).toEqual({ id: INVOICE_ID, version: 4 });
    expect(args.data.version).toBe(5);
    expect(out.version).toBe(5);
  });
});

describe("MarkInvoiceUncollectible — redelivery", () => {
  it("treats an already-UNCOLLECTIBLE invoice as a complete no-op", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.UNCOLLECTIBLE, version: 7 },
    });
    configureBus(fake.client);

    const out = await run();

    // Without the short-circuit a redelivered event re-emits the
    // write-off event, and anything aggregating bad debt from that
    // stream counts the same loss twice.
    expect(out).toMatchObject({ recognized: true, transitioned: false, version: 7 });
    expect(callsOf(fake.calls, "invoice", "updateMany")).toHaveLength(0);
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
    expect(auditDataOf(fake.calls).action).toBe("billing.invoice.stripe_uncollectible.skipped");
  });

  it("stamps the caller's idempotency key on command_log", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run(validInput, "stripe-event:evt_TestUncollectible1");

    // `executeSystemCommand` keeps no idempotency cache; the unique
    // index on (organizationId, commandName, idempotencyKey) is the
    // only barrier against a re-run drain job writing off the same
    // balance twice, and it only applies if the key reaches the row.
    const log = callsOf(fake.calls, "commandLog", "create")[0];
    const data = (log!.args as { data: Record<string, unknown> }).data;
    expect(data["idempotencyKey"]).toBe("stripe-event:evt_TestUncollectible1");
    expect(data["commandName"]).toBe("MarkInvoiceUncollectible");
  });
});

describe("MarkInvoiceUncollectible — state guards", () => {
  it("refuses to write off a PAID invoice and writes nothing", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.PAID },
    });
    configureBus(fake.client);

    // Writing off money that was collected books a loss against cash
    // the pharmacy actually holds.
    await expect(run()).rejects.toMatchObject({
      code: MARK_UNCOLLECTIBLE_INVALID_STATUS_TRANSITION,
    });
    expect(callsOf(fake.calls, "invoice", "updateMany")).toHaveLength(0);
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
  });

  it("refuses to write off a VOID invoice and writes nothing", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.VOID },
    });
    configureBus(fake.client);

    // A voided invoice was never collectable, so there is no balance
    // to write off — booking one would invent bad debt.
    await expect(run()).rejects.toMatchObject({
      code: MARK_UNCOLLECTIBLE_INVALID_STATUS_TRANSITION,
    });
    expect(callsOf(fake.calls, "invoice", "updateMany")).toHaveLength(0);
  });

  it("surfaces a version mismatch when a concurrent mutation won the row", async () => {
    const fake = buildPrismaFake({ casCount: 0 });
    configureBus(fake.client);

    await expect(run()).rejects.toMatchObject({ code: MARK_UNCOLLECTIBLE_VERSION_MISMATCH });
  });
});

describe("MarkInvoiceUncollectible — tenancy and Stripe linkage", () => {
  it("resolves the invoice by organization as well as id", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    // Scoping by id alone would let one tenant's webhook write off
    // another tenant's receivable.
    const lookup = callsOf(fake.calls, "invoice", "findFirst")[0];
    const where = (lookup!.args as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ id: INVOICE_ID, organizationId: ORG_ID });
  });

  it("reports an invoice outside the target org as unrecognized instead of writing it off", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);

    const out = await run();

    expect(out).toMatchObject({ recognized: false, transitioned: false });
    expect(callsOf(fake.calls, "invoice", "updateMany")).toHaveLength(0);
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
    expect(auditDataOf(fake.calls).action).toBe(
      "billing.invoice.stripe_uncollectible.unrecognized"
    );
  });

  it("refuses when the invoice is linked to a DIFFERENT Stripe invoice", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), stripeInvoiceId: "in_SomeoneElsesInvoice" },
    });
    configureBus(fake.client);

    await expect(run()).rejects.toMatchObject({
      code: "MARK_UNCOLLECTIBLE_STRIPE_INVOICE_MISMATCH",
    });
    expect(callsOf(fake.calls, "invoice", "updateMany")).toHaveLength(0);
  });

  it("backfills an absent Stripe link, and never rewrites an existing one", async () => {
    const unlinked = buildPrismaFake({
      invoice: { ...defaultInvoice(), stripeInvoiceId: null },
    });
    configureBus(unlinked.client);
    await run();
    expect(casDataOf(unlinked.calls)["stripeInvoiceId"]).toBe(STRIPE_INVOICE_ID);

    resetCommandBusConfigurationForTests();
    const linked = buildPrismaFake();
    configureBus(linked.client);
    await run();
    expect(casDataOf(linked.calls)).not.toHaveProperty("stripeInvoiceId");
  });
});

describe("MarkInvoiceUncollectible — evidence", () => {
  it("records the before/after status and the originating Stripe event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    const audit = auditDataOf(fake.calls);
    expect(audit.action).toBe("billing.invoice.stripe_uncollectible");
    expect(audit.metadata).toMatchObject({
      invoiceId: INVOICE_ID,
      clinicId: CLINIC_ID,
      invoiceNumber: "INV-2026-05-0c0c0c0c",
      previousStatus: "OPEN",
      newStatus: "UNCOLLECTIBLE",
      stripeEventId: validInput.stripeEventId,
      recordedAt: RECORDED_AT,
    });
  });

  it("emits billing.invoice.uncollectible.v1 scoped to the invoice's own organization", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    const rows = outboxRowsOf(fake.calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("billing.invoice.uncollectible.v1");
    expect(rows[0]?.payload).toMatchObject({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      invoiceId: INVOICE_ID,
      recordedAt: RECORDED_AT,
    });
  });
});
