// RecordInvoicePaymentFailure contract tests.
//
// The odd one out of the Stripe billing commands: it deliberately
// changes no money and no status. Stripe keeps retrying collection on
// its own schedule, so this command exists to leave evidence of the
// attempt and to hand a future notification slice something to react
// to. The tests therefore pin two things — that it stays read-only
// against the invoice, and that the failure detail survives into the
// audit row and the event without being reshaped.
//
// Surface:
//   - Read-only: no CAS, no status change, no version bump, at any
//     invoice status.
//   - Payload fidelity: optional Stripe detail lands as explicit
//     null rather than a missing key; cent amounts pass through as
//     integers.
//   - Tenancy: the lookup is scoped by organizationId; an invoice
//     outside the target org is unrecognized and emits nothing.
//   - Evidence: audit action + `billing.invoice.payment_failed.v1`.
//   - Replay: the handler holds no dedupe of its own (see the test
//     that names this). What backs redelivery is the idempotency key
//     reaching `command_log`: dispatch the same key twice and the bus
//     replays the first attempt's output instead of recording a second
//     one. The fake below models that unique index, so both halves of
//     that claim — same key replays, different keys don't — are
//     assertions here rather than prose.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { InvoiceStatus, Prisma } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

import { RecordInvoicePaymentFailure } from "./record-invoice-payment-failure.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const STRIPE_INVOICE_ID = "in_TestStripeInvoice";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const FAILED_AT = "2026-05-31T23:30:00.000Z";

interface FakeInvoice {
  id: string;
  organizationId: string;
  invoiceNumber: string;
  clinicId: string;
  status: InvoiceStatus;
  stripeInvoiceId: string | null;
}

interface FakeOverrides {
  invoice?: FakeInvoice | null;
}

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

const defaultInvoice = (): FakeInvoice => ({
  id: INVOICE_ID,
  organizationId: ORG_ID,
  invoiceNumber: "INV-2026-05-0c0c0c0c",
  clinicId: CLINIC_ID,
  status: InvoiceStatus.OPEN,
  stripeInvoiceId: STRIPE_INVOICE_ID,
});

/**
 * The P2002 the `(organizationId, commandName, idempotencyKey)` unique
 * index on `command_log` raises when a second attempt reuses a key.
 * Built off the prototype rather than `new`-ed because the real
 * constructor needs the Prisma client runtime.
 */
function commandLogKeyCollision(): Error {
  const err = Object.create(Prisma.PrismaClientKnownRequestError.prototype) as Error & {
    code: string;
    meta: Record<string, unknown>;
  };
  Object.assign(err, {
    code: "P2002",
    meta: { modelName: "CommandLog" },
    message: "Unique constraint failed",
  });
  return err;
}

interface FakeCommandLogRow {
  id: string;
  organizationId: string;
  commandName: string;
  idempotencyKey: string;
  status: string;
  responsePayload: unknown;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const invoice = overrides.invoice === undefined ? defaultInvoice() : overrides.invoice;

  // `command_log` rows this fake has accepted, so the unique index on
  // (organizationId, commandName, idempotencyKey) is modelled rather
  // than assumed. Without it a same-key re-dispatch would silently
  // insert twice here and the replay tests below would prove nothing.
  const commandLogRows: FakeCommandLogRow[] = [];
  const uniqueKeyOf = (row: {
    organizationId: string;
    commandName: string;
    idempotencyKey: string;
  }): string => `${row.organizationId}::${row.commandName}::${row.idempotencyKey}`;

  const tx = {
    invoice: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "findFirst", args });
        return invoice;
      }),
      // Present so "this command never mutates the invoice" is an
      // assertion rather than an absence the fake made impossible.
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "update", args });
        return { id: INVOICE_ID };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "updateMany", args });
        return { count: 1 };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        const data = (args as { data: FakeCommandLogRow }).data;
        if (commandLogRows.some((r) => uniqueKeyOf(r) === uniqueKeyOf(data))) {
          throw commandLogKeyCollision();
        }
        commandLogRows.push({ ...data, responsePayload: null });
        return { id: data.id };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        const { where, data } = args as {
          where: { id: string };
          data: { status?: string; responsePayload?: unknown };
        };
        const row = commandLogRows.find((r) => r.id === where.id);
        if (row !== undefined) {
          if (data.status !== undefined) row.status = data.status;
          if (data.responsePayload !== undefined) row.responsePayload = data.responsePayload;
        }
        return { ok: true };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "findUnique", args });
        const where = (
          args as {
            where: {
              organizationId_commandName_idempotencyKey: {
                organizationId: string;
                commandName: string;
                idempotencyKey: string;
              };
            };
          }
        ).where.organizationId_commandName_idempotencyKey;
        return commandLogRows.find((r) => uniqueKeyOf(r) === uniqueKeyOf(where)) ?? null;
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
  stripeEventId: "evt_TestFailed1",
  failureCode: "card_declined",
  failureMessage: "Your card was declined.",
  attemptedAmountCents: 15_000,
  nextAttemptAt: "2026-06-04T23:30:00.000Z",
  failedAt: FAILED_AT,
};

const run = (input: unknown = validInput, idempotencyKey?: string) =>
  withSystemContext("billing-test", () =>
    idempotencyKey === undefined
      ? executeSystemCommand(RecordInvoicePaymentFailure, input)
      : executeSystemCommand(RecordInvoicePaymentFailure, input, { idempotencyKey })
  );

beforeEach(() => {
  const fake = buildPrismaFake();
  configureBus(fake.client);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

describe("RecordInvoicePaymentFailure — stays read-only", () => {
  it("records the attempt without touching the invoice row", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await run();

    // Stripe has not given up yet — it will retry on its own
    // schedule. Moving the invoice here would take the receivable
    // out of collection while Stripe is still trying to collect it.
    expect(out).toEqual({ invoiceId: INVOICE_ID, recognized: true });
    expect(callsOf(fake.calls, "invoice", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "invoice", "updateMany")).toHaveLength(0);
  });

  it("still records nothing but evidence when the invoice is already PAID", async () => {
    // Out-of-order delivery: the paid event landed first. The record
    // of the failed attempt still belongs on the timeline, but it
    // must not disturb a settled invoice.
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.PAID },
    });
    configureBus(fake.client);

    const out = await run();

    expect(out.recognized).toBe(true);
    expect(callsOf(fake.calls, "invoice", "updateMany")).toHaveLength(0);
    expect(auditDataOf(fake.calls).metadata["currentStatus"]).toBe("PAID");
  });
});

describe("RecordInvoicePaymentFailure — payload fidelity", () => {
  it("carries the decline detail and the attempted amount into the event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    const rows = outboxRowsOf(fake.calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("billing.invoice.payment_failed.v1");
    expect(rows[0]?.payload).toMatchObject({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      invoiceId: INVOICE_ID,
      invoiceNumber: "INV-2026-05-0c0c0c0c",
      failureCode: "card_declined",
      attemptedAmountCents: 15_000,
      nextAttemptAt: "2026-06-04T23:30:00.000Z",
      failedAt: FAILED_AT,
    });
    expect(Number.isInteger(rows[0]?.payload["attemptedAmountCents"])).toBe(true);
  });

  it("writes absent Stripe detail as explicit null, not a missing key", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run({
      invoiceId: INVOICE_ID,
      organizationId: ORG_ID,
      stripeInvoiceId: STRIPE_INVOICE_ID,
      stripeEventId: "evt_TestFailedSparse",
      failedAt: FAILED_AT,
    });

    // The event is JSON on the wire, where `undefined` drops the key
    // altogether. A consumer reading `payload.attemptedAmountCents`
    // would then see a missing field rather than "Stripe told us
    // nothing", and the two are not the same fact.
    const payload = outboxRowsOf(fake.calls)[0]?.payload ?? {};
    expect(payload).toMatchObject({
      failureCode: null,
      attemptedAmountCents: null,
      nextAttemptAt: null,
    });
    expect(Object.keys(payload)).toEqual(
      expect.arrayContaining(["failureCode", "attemptedAmountCents", "nextAttemptAt"])
    );
    expect(auditDataOf(fake.calls).metadata["failureMessage"]).toBeNull();
  });

  it("preserves a zero attempted amount rather than folding it to null", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run({ ...validInput, attemptedAmountCents: 0 });

    // `?? null` keeps 0 and only replaces undefined. A `||` here
    // would report a genuine zero-dollar attempt as "unknown".
    expect(outboxRowsOf(fake.calls)[0]?.payload["attemptedAmountCents"]).toBe(0);
  });

  it("dates the failure from the Stripe event rather than the local clock", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    const metadata = auditDataOf(fake.calls).metadata;
    expect(metadata["failedAt"]).toBe(FAILED_AT);
    expect(metadata["occurredAt"]).toBe(NOW.toISOString());
  });
});

describe("RecordInvoicePaymentFailure — tenancy", () => {
  it("resolves the invoice by organization as well as id", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    // Unscoped, a webhook could attach one tenant's collection
    // failure to another tenant's invoice timeline.
    const lookup = callsOf(fake.calls, "invoice", "findFirst")[0];
    const where = (lookup!.args as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ id: INVOICE_ID, organizationId: ORG_ID });
  });

  it("reports an invoice outside the target org as unrecognized and emits nothing", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);

    const out = await run();

    expect(out).toEqual({ invoiceId: INVOICE_ID, recognized: false });
    expect(outboxRowsOf(fake.calls)).toHaveLength(0);
    expect(auditDataOf(fake.calls).action).toBe(
      "billing.invoice.stripe_payment_failed.unrecognized"
    );
  });
});

describe("RecordInvoicePaymentFailure — evidence and replay", () => {
  it("records the attempt on the audit chain with its originating event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();

    const audit = auditDataOf(fake.calls);
    expect(audit.action).toBe("billing.invoice.stripe_payment_failed");
    expect(audit.metadata).toMatchObject({
      invoiceId: INVOICE_ID,
      clinicId: CLINIC_ID,
      stripeEventId: "evt_TestFailed1",
      failureCode: "card_declined",
      currentStatus: "OPEN",
    });
  });

  it("stamps the caller's idempotency key on command_log", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run(validInput, "stripe-event:evt_TestFailed1");

    // This command has no state to short-circuit on, so unlike its
    // voided/uncollectible siblings the key is the ONLY thing that
    // makes a redelivery distinguishable from a new attempt.
    const log = callsOf(fake.calls, "commandLog", "create")[0];
    const data = (log!.args as { data: Record<string, unknown> }).data;
    expect(data["idempotencyKey"]).toBe("stripe-event:evt_TestFailed1");
    expect(data["commandName"]).toBe("RecordInvoicePaymentFailure");
  });

  it("does NOT dedupe on stripeEventId itself — replays re-emit the event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await run();
    await run();

    // Both dispatches carry the SAME `stripeEventId` and land twice,
    // because neither passes an idempotency key and the bus defaults
    // to a fresh ULID per attempt. Nothing in this handler looks at
    // `stripeEventId`, so a caller that does not supply a key gets a
    // second dunning record — which is why the drain supplies one (see
    // the next test). Add a `stripeEventId` check here and this test
    // stops describing production behaviour.
    expect(outboxRowsOf(fake.calls)).toHaveLength(2);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(2);
  });

  it("re-dispatching under the SAME idempotency key replays instead of recording again", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const key = "stripe-event:evt_TestFailed1";
    const first = await run(validInput, key);
    const second = await run(validInput, key);

    // This is the drain's real duplicate: the worker crashed after the
    // command committed but before the webhook inbox row was marked
    // processed, the lease expired, and the row was re-claimed. The
    // second dispatch hits the command_log unique index on the key and
    // the bus hands back the first attempt's recorded output.
    expect(second).toEqual(first);
    expect(outboxRowsOf(fake.calls)).toHaveLength(1);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(1);
  });
});
