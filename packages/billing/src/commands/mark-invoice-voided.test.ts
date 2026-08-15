// MarkInvoiceVoided contract tests.
//
// `mark-invoice-terminal-status.test.ts` covers the shape this
// command shares with its two siblings. This file covers what is
// specific to voiding, and what a shared-shape test cannot: where the
// money lands, which source statuses are legal, and what a redelivered
// event is allowed to do a second time.
//
// Surface:
//   - Transition: OPEN/DRAFT → VOID, amountDue zeroed, recorded
//     totals untouched, voidedAt taken from the Stripe event.
//   - Redelivery: already-VOID is a total no-op — no CAS, no outbox.
//   - State guards: PAID and UNCOLLECTIBLE are refused.
//   - Tenancy: the lookup is scoped by organizationId; an invoice
//     outside the target org is unrecognized, never voided.
//   - Stripe linkage: mismatched link refused, absent link backfilled.
//   - Concurrency: CAS miss surfaces MARK_VOIDED_VERSION_MISMATCH.
//   - Evidence: audit action + `billing.invoice.voided.v1`.

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
  MARK_VOIDED_INVALID_STATUS_TRANSITION,
  MARK_VOIDED_VERSION_MISMATCH,
  MarkInvoiceVoided,
} from "./mark-invoice-voided.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const STRIPE_INVOICE_ID = "in_TestStripeInvoice";

// The event timestamp is deliberately NOT the frozen clock: several
// assertions below depend on telling the two apart.
const NOW = new Date("2026-06-01T00:00:00.000Z");
const VOIDED_AT = "2026-05-31T23:30:00.000Z";

interface FakeInvoice {
  id: string;
  organizationId: string;
  status: InvoiceStatus;
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
  voidedAt: VOIDED_AT,
  stripeEventId: "evt_TestVoided1",
};

const run = (input: unknown = validInput, idempotencyKey?: string) =>
  withSystemContext("billing-test", () =>
    idempotencyKey === undefined
      ? executeSystemCommand(MarkInvoiceVoided, input)
      : executeSystemCommand(MarkInvoiceVoided, input, { idempotencyKey })
  );

beforeEach(() => {
  const fake = buildPrismaFake();
  configureBus(fake.client);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

describe("MarkInvoiceVoided — the money write", () => {
  it("zeroes the balance due but leaves the recorded totals alone", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await run();

    expect(out).toMatchObject({ transitioned: true, status: "VOID", version: 5 });

    const data = casDataOf(fake.calls);
    expect(data["status"]).toBe("VOID");
    expect(data["amountDueCents"]).toBe(0);
    expect(Number.isInteger(data["amountDueCents"])).toBe(true);
    // subtotal/total are the record of what was billed. A void says
    // "nothing is collectable", not "nothing was ever charged" — if
    // this write started clearing them, the invoice would still exist
    // but every revenue and adjustment report built on it would read
    // zero, with no trace of the original amount.
    expect(data).not.toHaveProperty("subtotalCents");
    expect(data).not.toHaveProperty("totalCents");
    expect(data).not.toHaveProperty("amountPaidCents");
  });

  it("dates the void from the Stripe event rather than the local clock", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    // Aging and collection reports bucket on voidedAt. Drain lag can
    // be hours; stamping our own clock would silently move revenue
    // between reporting periods.
    const data = casDataOf(fake.calls);
    expect(data["voidedAt"]).toBeInstanceOf(Date);
    expect((data["voidedAt"] as Date).toISOString()).toBe(VOIDED_AT);
    expect((data["voidedAt"] as Date).getTime()).not.toBe(NOW.getTime());
  });

  it("advances the version by exactly one against the observed row", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    const cas = callsOf(fake.calls, "invoice", "updateMany")[0];
    const args = cas!.args as { where: { id: string; version: number }; data: { version: number } };
    expect(args.where).toEqual({ id: INVOICE_ID, version: 4 });
    expect(args.data.version).toBe(5);
  });

  it("voids a DRAFT invoice — only PAID and UNCOLLECTIBLE are terminal", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.DRAFT },
    });
    configureBus(fake.client);

    const out = await run();

    expect(out.transitioned).toBe(true);
    expect(auditDataOf(fake.calls).metadata["previousStatus"]).toBe("DRAFT");
  });
});

describe("MarkInvoiceVoided — redelivery", () => {
  it("treats an already-VOID invoice as a complete no-op", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.VOID, version: 7 },
    });
    configureBus(fake.client);

    const out = await run();

    // Stripe redelivers. Without this short-circuit the second
    // delivery re-runs the CAS and re-emits the voided event, so any
    // consumer that reverses a receivable on that event reverses it
    // twice.
    expect(out).toMatchObject({ recognized: true, transitioned: false, version: 7 });
    expect(callsOf(fake.calls, "invoice", "updateMany")).toHaveLength(0);
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
    expect(auditDataOf(fake.calls).action).toBe("billing.invoice.stripe_voided.skipped");
  });

  it("stamps the caller's idempotency key on command_log", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run(validInput, "stripe-event:evt_TestVoided1");

    // `executeSystemCommand` keeps no idempotency cache, so the
    // unique index on (organizationId, commandName, idempotencyKey)
    // is the only thing standing between a re-run drain job and a
    // second application of this command. That backstop exists only
    // if the key actually reaches the row.
    const log = callsOf(fake.calls, "commandLog", "create")[0];
    const data = (log!.args as { data: Record<string, unknown> }).data;
    expect(data["idempotencyKey"]).toBe("stripe-event:evt_TestVoided1");
    expect(data["commandName"]).toBe("MarkInvoiceVoided");
  });
});

describe("MarkInvoiceVoided — state guards", () => {
  it("refuses to void a PAID invoice and writes nothing", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.PAID },
    });
    configureBus(fake.client);

    // Voiding a collected invoice would zero amountDue on money that
    // was actually received, so the clinic's balance and the cash
    // reconciliation stop agreeing with no record of why.
    await expect(run()).rejects.toMatchObject({
      code: MARK_VOIDED_INVALID_STATUS_TRANSITION,
    });
    expect(callsOf(fake.calls, "invoice", "updateMany")).toHaveLength(0);
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
  });

  it("refuses to void an UNCOLLECTIBLE invoice and writes nothing", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.UNCOLLECTIBLE },
    });
    configureBus(fake.client);

    // The write-off already moved this balance. Re-voiding it would
    // emit a second terminal event for one receivable.
    await expect(run()).rejects.toMatchObject({
      code: MARK_VOIDED_INVALID_STATUS_TRANSITION,
    });
    expect(callsOf(fake.calls, "invoice", "updateMany")).toHaveLength(0);
  });

  it("surfaces a version mismatch when a concurrent mutation won the row", async () => {
    const fake = buildPrismaFake({ casCount: 0 });
    configureBus(fake.client);

    await expect(run()).rejects.toMatchObject({ code: MARK_VOIDED_VERSION_MISMATCH });
  });
});

describe("MarkInvoiceVoided — tenancy and Stripe linkage", () => {
  it("resolves the invoice by organization as well as id", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    // A lookup keyed on invoice id alone would let a webhook carrying
    // one tenant's org id zero another tenant's receivable.
    const lookup = callsOf(fake.calls, "invoice", "findFirst")[0];
    const where = (lookup!.args as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ id: INVOICE_ID, organizationId: ORG_ID });
  });

  it("reports an invoice outside the target org as unrecognized instead of voiding it", async () => {
    // The handler cannot see rows in another tenant, so a
    // cross-tenant id resolves to nothing — the same path as an
    // orphan Stripe invoice, and never a mutation.
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);

    const out = await run();

    expect(out).toMatchObject({ recognized: false, transitioned: false });
    expect(callsOf(fake.calls, "invoice", "updateMany")).toHaveLength(0);
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
    expect(auditDataOf(fake.calls).action).toBe("billing.invoice.stripe_voided.unrecognized");
  });

  it("refuses when the invoice is linked to a DIFFERENT Stripe invoice", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), stripeInvoiceId: "in_SomeoneElsesInvoice" },
    });
    configureBus(fake.client);

    await expect(run()).rejects.toMatchObject({
      code: "MARK_VOIDED_STRIPE_INVOICE_MISMATCH",
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

describe("MarkInvoiceVoided — evidence", () => {
  it("records the before/after status and the originating Stripe event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    const audit = auditDataOf(fake.calls);
    expect(audit.action).toBe("billing.invoice.stripe_voided");
    expect(audit.metadata).toMatchObject({
      invoiceId: INVOICE_ID,
      clinicId: CLINIC_ID,
      invoiceNumber: "INV-2026-05-0c0c0c0c",
      previousStatus: "OPEN",
      newStatus: "VOID",
      stripeEventId: validInput.stripeEventId,
      voidedAt: VOIDED_AT,
    });
  });

  it("emits billing.invoice.voided.v1 scoped to the invoice's own organization", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    const rows = outboxRowsOf(fake.calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("billing.invoice.voided.v1");
    expect(rows[0]?.payload).toMatchObject({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      invoiceId: INVOICE_ID,
      voidedAt: VOIDED_AT,
    });
  });
});
