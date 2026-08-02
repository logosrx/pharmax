// RecordManualPayment contract tests.
//
// Surface:
//   - Partial payment: amountPaid/amountDue move by the amount, the
//     invoice stays OPEN, the ledger row is MANUAL/PAYMENT with a
//     `manual:{ulid}` key, only `billing.payment.recorded.v1` emits.
//   - Full settle: OPEN → PAID flip with paidAt = receivedAt, and
//     `billing.invoice.paid.v1` emits with a null stripeInvoiceId.
//   - Backdating: receivedAt in the past lands on both the ledger
//     row's occurredAt and the invoice's paidAt.
//   - Guards: future receivedAt, overpayment, DRAFT / PAID / VOID /
//     UNCOLLECTIBLE statuses, missing invoice, CAS version mismatch.
//   - PHI: operatorNote never appears in audit metadata (only
//     `hasOperatorNote`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { InvoiceStatus, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  RECORD_MANUAL_PAYMENT_AMOUNT_EXCEEDS_DUE,
  RECORD_MANUAL_PAYMENT_INVALID_STATUS,
  RECORD_MANUAL_PAYMENT_INVOICE_NOT_FOUND,
  RECORD_MANUAL_PAYMENT_RECEIVED_AT_IN_FUTURE,
  RECORD_MANUAL_PAYMENT_VERSION_MISMATCH,
  RecordManualPayment,
} from "./record-manual-payment.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";

/** Matches the frozen bus clock configured in configureBus(). */
const FROZEN_NOW = "2026-06-01T10:00:00.000Z";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.BILLING_RECORD_MANUAL_PAYMENT]),
  },
];

interface FakeInvoice {
  id: string;
  clinicId: string;
  status: InvoiceStatus;
  currency: string;
  totalCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  stripeInvoiceId: string | null;
  stripeChargeId: string | null;
  invoiceNumber: string;
  version: number;
}

interface FakeOverrides {
  invoice?: FakeInvoice | null;
  /** When true, invoice.updateMany reports 0 rows (CAS miss). */
  versionMismatch?: boolean;
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

const defaultInvoice = (): FakeInvoice => ({
  id: INVOICE_ID,
  clinicId: CLINIC_ID,
  status: InvoiceStatus.OPEN,
  currency: "usd",
  totalCents: 10_000,
  amountPaidCents: 0,
  amountDueCents: 10_000,
  stripeInvoiceId: null,
  stripeChargeId: null,
  invoiceNumber: "INV-2026-06-0c0c0c0c",
  version: 3,
});

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const invoice = overrides.invoice === undefined ? defaultInvoice() : overrides.invoice;

  const tx = {
    invoice: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "findFirst", args });
        return invoice;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "updateMany", args });
        return { count: overrides.versionMismatch === true ? 0 : 1 };
      }),
    },
    payment: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "payment", op: "create", args });
        return { id: (args as { data: { id: string } }).data.id };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "payment", op: "findUnique", args });
        return null;
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
      findUnique: vi.fn(async () => null),
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
    idempotencyKey: {
      create: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 0),
  };

  const client = {
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-pre" })),
      update: vi.fn(async () => ({ ok: true })),
    },
    idempotencyKey: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date(FROZEN_NOW)),
    logger: logger.noopLogger,
  });
}

const ctxFor = () =>
  buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });

function findCall(calls: FakeCall[], table: string, op: string): FakeCall | undefined {
  return calls.find((c) => c.table === table && c.op === op);
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("RecordManualPayment — partial payment", () => {
  it("moves the balances, keeps OPEN, writes a MANUAL ledger row, emits only payment.recorded", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordManualPayment,
        {
          invoiceId: INVOICE_ID,
          amountCents: 6_000,
          instrument: "CHECK",
          referenceNumber: "1234",
        },
        { idempotencyKey: "manual-partial-1" }
      )
    );

    expect(out).toMatchObject({
      invoiceId: INVOICE_ID,
      amountCents: 6_000,
      amountPaidCentsAfter: 6_000,
      amountDueCentsAfter: 4_000,
      fullyPaid: false,
      status: InvoiceStatus.OPEN,
      version: 4,
    });

    const update = findCall(fake.calls, "invoice", "updateMany");
    const updateArgs = update!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(updateArgs.where).toMatchObject({ id: INVOICE_ID, version: 3 });
    expect(updateArgs.data["amountPaidCents"]).toEqual({ increment: 6_000 });
    expect(updateArgs.data["amountDueCents"]).toEqual({ decrement: 6_000 });
    expect(updateArgs.data["status"]).toBeUndefined();
    expect(updateArgs.data["paidAt"]).toBeUndefined();

    const paymentCreate = findCall(fake.calls, "payment", "create");
    const paymentData = (paymentCreate!.args as { data: Record<string, unknown> }).data;
    expect(paymentData["kind"]).toBe("PAYMENT");
    expect(paymentData["method"]).toBe("MANUAL");
    expect(paymentData["amountCents"]).toBe(6_000);
    expect(paymentData["paymentEventKey"]).toMatch(/^manual:/);
    expect(paymentData["stripeEventId"]).toBeNull();
    const paymentMetadata = paymentData["metadata"] as Record<string, unknown>;
    expect(paymentMetadata["instrument"]).toBe("CHECK");
    expect(paymentMetadata["referenceNumber"]).toBe("1234");

    const outbox = findCall(fake.calls, "eventOutbox", "createMany");
    const outboxData = (outbox!.args as { data: Array<{ eventType: string }> }).data;
    expect(outboxData.map((e) => e.eventType)).toEqual(["billing.payment.recorded.v1"]);
  });
});

describe("RecordManualPayment — full settle", () => {
  it("flips OPEN → PAID with paidAt and emits invoice.paid.v1 with null stripeInvoiceId", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordManualPayment,
        { invoiceId: INVOICE_ID, amountCents: 10_000, instrument: "WIRE" },
        { idempotencyKey: "manual-full-1" }
      )
    );

    expect(out).toMatchObject({
      fullyPaid: true,
      status: InvoiceStatus.PAID,
      amountDueCentsAfter: 0,
    });

    const update = findCall(fake.calls, "invoice", "updateMany");
    const updateData = (update!.args as { data: Record<string, unknown> }).data;
    expect(updateData["status"]).toBe(InvoiceStatus.PAID);
    expect((updateData["paidAt"] as Date).toISOString()).toBe(FROZEN_NOW);

    const outbox = findCall(fake.calls, "eventOutbox", "createMany");
    const outboxData = (
      outbox!.args as { data: Array<{ eventType: string; payload: Record<string, unknown> }> }
    ).data;
    expect(outboxData.map((e) => e.eventType)).toEqual([
      "billing.payment.recorded.v1",
      "billing.invoice.paid.v1",
    ]);
    const paidPayload = outboxData[1]!.payload;
    expect(paidPayload["stripeInvoiceId"]).toBeNull();
    expect(paidPayload["stripeChargeId"]).toBeNull();
    expect(paidPayload["amountPaidCents"]).toBe(10_000);
    expect(paidPayload["paidAt"]).toBe(FROZEN_NOW);
  });

  it("stamps a backdated receivedAt on both occurredAt and paidAt", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    const receivedAt = "2026-05-28T15:00:00.000Z";

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordManualPayment,
        { invoiceId: INVOICE_ID, amountCents: 10_000, instrument: "ACH", receivedAt },
        { idempotencyKey: "manual-backdated-1" }
      )
    );

    const paymentCreate = findCall(fake.calls, "payment", "create");
    const paymentData = (paymentCreate!.args as { data: Record<string, unknown> }).data;
    expect((paymentData["occurredAt"] as Date).toISOString()).toBe(receivedAt);

    const update = findCall(fake.calls, "invoice", "updateMany");
    const updateData = (update!.args as { data: Record<string, unknown> }).data;
    expect((updateData["paidAt"] as Date).toISOString()).toBe(receivedAt);
  });
});

describe("RecordManualPayment — guards", () => {
  it("rejects a receivedAt in the future", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          RecordManualPayment,
          {
            invoiceId: INVOICE_ID,
            amountCents: 1_000,
            instrument: "CHECK",
            receivedAt: "2026-06-02T10:00:00.000Z",
          },
          { idempotencyKey: "manual-future-1" }
        )
      )
    ).rejects.toMatchObject({ code: RECORD_MANUAL_PAYMENT_RECEIVED_AT_IN_FUTURE });

    expect(findCall(fake.calls, "payment", "create")).toBeUndefined();
    expect(findCall(fake.calls, "invoice", "updateMany")).toBeUndefined();
  });

  it("rejects an amount above the remaining balance", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), amountPaidCents: 7_000, amountDueCents: 3_000 },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          RecordManualPayment,
          { invoiceId: INVOICE_ID, amountCents: 3_001, instrument: "CHECK" },
          { idempotencyKey: "manual-over-1" }
        )
      )
    ).rejects.toMatchObject({ code: RECORD_MANUAL_PAYMENT_AMOUNT_EXCEEDS_DUE });

    expect(findCall(fake.calls, "payment", "create")).toBeUndefined();
  });

  it.each([
    InvoiceStatus.DRAFT,
    InvoiceStatus.PAID,
    InvoiceStatus.VOID,
    InvoiceStatus.UNCOLLECTIBLE,
  ])("rejects an invoice in %s status", async (status) => {
    const fake = buildPrismaFake({ invoice: { ...defaultInvoice(), status } });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          RecordManualPayment,
          { invoiceId: INVOICE_ID, amountCents: 1_000, instrument: "CASH" },
          { idempotencyKey: `manual-status-${status}` }
        )
      )
    ).rejects.toMatchObject({ code: RECORD_MANUAL_PAYMENT_INVALID_STATUS });
  });

  it("rejects a missing invoice", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          RecordManualPayment,
          { invoiceId: INVOICE_ID, amountCents: 1_000, instrument: "CHECK" },
          { idempotencyKey: "manual-missing-1" }
        )
      )
    ).rejects.toMatchObject({ code: RECORD_MANUAL_PAYMENT_INVOICE_NOT_FOUND });
  });

  it("surfaces a CAS version mismatch as a typed conflict, with no ledger row", async () => {
    const fake = buildPrismaFake({ versionMismatch: true });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          RecordManualPayment,
          { invoiceId: INVOICE_ID, amountCents: 1_000, instrument: "CHECK" },
          { idempotencyKey: "manual-cas-1" }
        )
      )
    ).rejects.toMatchObject({ code: RECORD_MANUAL_PAYMENT_VERSION_MISMATCH });

    expect(findCall(fake.calls, "payment", "create")).toBeUndefined();
  });
});

describe("RecordManualPayment — PHI hygiene", () => {
  it("keeps operatorNote out of audit metadata, surfacing only hasOperatorNote", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        RecordManualPayment,
        {
          invoiceId: INVOICE_ID,
          amountCents: 1_000,
          instrument: "CHECK",
          operatorNote: "clinic mailed check with June statement",
        },
        { idempotencyKey: "manual-note-1" }
      )
    );

    const audit = findCall(fake.calls, "auditLog", "create");
    // Stringify only `metadata` — the full audit row carries a BigInt
    // chain seq that JSON.stringify cannot serialize.
    const metadata = (audit!.args as { data: { metadata: unknown } }).data.metadata;
    const metadataJson = JSON.stringify(metadata);
    expect(metadataJson).not.toContain("clinic mailed check");
    expect(metadataJson).toContain('"hasOperatorNote":true');
  });
});
