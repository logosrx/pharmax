// ApplyClinicCredit contract tests.
//
// Surface:
//   - Partial application: amountPaid/amountDue move by the amount,
//     the invoice stays OPEN, a CREDIT_BALANCE payment-ledger row
//     and an APPLICATION credit entry are written with a SHARED
//     `credit-apply:{ulid}` key, `billing.payment.recorded.v1` +
//     `billing.clinic_credit.recorded.v1` emit.
//   - Full settle: OPEN → PAID flip with paidAt = now, and
//     `billing.invoice.paid.v1` emits with a null stripeInvoiceId.
//   - Guards: insufficient credit balance, amount above the
//     invoice's remaining balance, DRAFT / PAID / VOID /
//     UNCOLLECTIBLE statuses, missing invoice, CAS version mismatch.
//   - PHI: operatorNote never appears in audit metadata.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { ClinicCreditEntryKind, InvoiceStatus, RoleScope } from "@pharmax/database";
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
  APPLY_CLINIC_CREDIT_AMOUNT_EXCEEDS_DUE,
  APPLY_CLINIC_CREDIT_INSUFFICIENT_BALANCE,
  APPLY_CLINIC_CREDIT_INVALID_STATUS,
  APPLY_CLINIC_CREDIT_INVOICE_NOT_FOUND,
  APPLY_CLINIC_CREDIT_VERSION_MISMATCH,
  ApplyClinicCredit,
} from "./apply-clinic-credit.js";

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
    permissions: new Set([PERMISSIONS.BILLING_MANAGE_CLINIC_CREDIT]),
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
  grantedCents?: number | null;
  appliedCents?: number | null;
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
      findUnique: vi.fn(async () => null),
    },
    clinicCreditEntry: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinicCreditEntry", op: "create", args });
        return { id: (args as { data: { id: string } }).data.id };
      }),
      findUnique: vi.fn(async () => null),
      aggregate: vi.fn(async (args: { where: { kind: string } }) => {
        calls.push({ table: "clinicCreditEntry", op: "aggregate", args });
        const sum =
          args.where.kind === ClinicCreditEntryKind.GRANT
            ? (overrides.grantedCents ?? null)
            : (overrides.appliedCents ?? null);
        return { _sum: { amountCents: sum } };
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
    $queryRaw: vi.fn(async (...args: unknown[]) => {
      calls.push({ table: "$raw", op: "$queryRaw", args });
      return [{ id: CLINIC_ID }];
    }),
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

describe("ApplyClinicCredit — partial application", () => {
  it("moves the balances, keeps OPEN, writes both ledger rows with a shared key", async () => {
    const fake = buildPrismaFake({ grantedCents: 5_000, appliedCents: 0 });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ApplyClinicCredit,
        { invoiceId: INVOICE_ID, amountCents: 4_000 },
        { idempotencyKey: "credit-apply-partial-1" }
      )
    );

    expect(out).toMatchObject({
      invoiceId: INVOICE_ID,
      clinicId: CLINIC_ID,
      amountCents: 4_000,
      amountPaidCentsAfter: 4_000,
      amountDueCentsAfter: 6_000,
      fullyPaid: false,
      status: InvoiceStatus.OPEN,
      version: 4,
      balanceAfterCents: 1_000,
    });

    const update = findCall(fake.calls, "invoice", "updateMany");
    const updateArgs = update!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(updateArgs.where).toMatchObject({ id: INVOICE_ID, version: 3 });
    expect(updateArgs.data["amountPaidCents"]).toEqual({ increment: 4_000 });
    expect(updateArgs.data["amountDueCents"]).toEqual({ decrement: 4_000 });
    expect(updateArgs.data["status"]).toBeUndefined();

    // Payment-ledger row: CREDIT_BALANCE, keyed credit-apply:{ulid}.
    const paymentCreate = findCall(fake.calls, "payment", "create");
    const paymentData = (paymentCreate!.args as { data: Record<string, unknown> }).data;
    expect(paymentData["kind"]).toBe("PAYMENT");
    expect(paymentData["method"]).toBe("CREDIT_BALANCE");
    expect(paymentData["amountCents"]).toBe(4_000);
    expect(paymentData["paymentEventKey"]).toMatch(/^credit-apply:/);

    // APPLICATION entry: same ulid in the key, back-linked to both rows.
    const entryCreate = findCall(fake.calls, "clinicCreditEntry", "create");
    const entryData = (entryCreate!.args as { data: Record<string, unknown> }).data;
    expect(entryData["kind"]).toBe("APPLICATION");
    expect(entryData["source"]).toBeNull();
    expect(entryData["creditEventKey"]).toBe(paymentData["paymentEventKey"]);
    expect(entryData["appliedToInvoiceId"]).toBe(INVOICE_ID);
    expect(entryData["appliedPaymentId"]).toBe(paymentData["id"]);

    const outbox = findCall(fake.calls, "eventOutbox", "createMany");
    const outboxData = (outbox!.args as { data: Array<{ eventType: string }> }).data;
    expect(outboxData.map((e) => e.eventType)).toEqual([
      "billing.payment.recorded.v1",
      "billing.clinic_credit.recorded.v1",
    ]);
  });
});

describe("ApplyClinicCredit — full settle", () => {
  it("flips OPEN → PAID and emits invoice.paid.v1 with null stripeInvoiceId", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), amountPaidCents: 6_000, amountDueCents: 4_000 },
      grantedCents: 4_000,
      appliedCents: 0,
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ApplyClinicCredit,
        { invoiceId: INVOICE_ID, amountCents: 4_000 },
        { idempotencyKey: "credit-apply-full-1" }
      )
    );

    expect(out).toMatchObject({
      fullyPaid: true,
      status: InvoiceStatus.PAID,
      amountDueCentsAfter: 0,
      balanceAfterCents: 0,
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
      "billing.clinic_credit.recorded.v1",
      "billing.invoice.paid.v1",
    ]);
    const paidPayload = outboxData[2]!.payload;
    expect(paidPayload["stripeInvoiceId"]).toBeNull();
    expect(paidPayload["amountPaidCents"]).toBe(10_000);
    expect(paidPayload["paidAt"]).toBe(FROZEN_NOW);

    const creditPayload = outboxData[1]!.payload;
    expect(creditPayload["kind"]).toBe("APPLICATION");
    expect(creditPayload["appliedToInvoiceId"]).toBe(INVOICE_ID);
    expect(creditPayload["balanceAfterCents"]).toBe(0);
  });
});

describe("ApplyClinicCredit — guards", () => {
  it("rejects an application above the clinic's credit balance, with no writes", async () => {
    const fake = buildPrismaFake({ grantedCents: 1_000, appliedCents: 0 });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ApplyClinicCredit,
          { invoiceId: INVOICE_ID, amountCents: 2_000 },
          { idempotencyKey: "credit-apply-insufficient-1" }
        )
      )
    ).rejects.toMatchObject({ code: APPLY_CLINIC_CREDIT_INSUFFICIENT_BALANCE });

    expect(findCall(fake.calls, "invoice", "updateMany")).toBeUndefined();
    expect(findCall(fake.calls, "payment", "create")).toBeUndefined();
    expect(findCall(fake.calls, "clinicCreditEntry", "create")).toBeUndefined();
  });

  it("counts prior applications against the balance", async () => {
    // Granted 5000, already applied 4500 → only 500 available.
    const fake = buildPrismaFake({ grantedCents: 5_000, appliedCents: 4_500 });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ApplyClinicCredit,
          { invoiceId: INVOICE_ID, amountCents: 501 },
          { idempotencyKey: "credit-apply-spent-1" }
        )
      )
    ).rejects.toMatchObject({ code: APPLY_CLINIC_CREDIT_INSUFFICIENT_BALANCE });
  });

  it("rejects an amount above the invoice's remaining balance", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), amountPaidCents: 7_000, amountDueCents: 3_000 },
      grantedCents: 100_000,
      appliedCents: 0,
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ApplyClinicCredit,
          { invoiceId: INVOICE_ID, amountCents: 3_001 },
          { idempotencyKey: "credit-apply-over-1" }
        )
      )
    ).rejects.toMatchObject({ code: APPLY_CLINIC_CREDIT_AMOUNT_EXCEEDS_DUE });

    expect(findCall(fake.calls, "payment", "create")).toBeUndefined();
  });

  it.each([
    InvoiceStatus.DRAFT,
    InvoiceStatus.PAID,
    InvoiceStatus.VOID,
    InvoiceStatus.UNCOLLECTIBLE,
  ])("rejects an invoice in %s status", async (status) => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status },
      grantedCents: 100_000,
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ApplyClinicCredit,
          { invoiceId: INVOICE_ID, amountCents: 1_000 },
          { idempotencyKey: `credit-apply-status-${status}` }
        )
      )
    ).rejects.toMatchObject({ code: APPLY_CLINIC_CREDIT_INVALID_STATUS });
  });

  it("rejects a missing invoice", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ApplyClinicCredit,
          { invoiceId: INVOICE_ID, amountCents: 1_000 },
          { idempotencyKey: "credit-apply-missing-1" }
        )
      )
    ).rejects.toMatchObject({ code: APPLY_CLINIC_CREDIT_INVOICE_NOT_FOUND });
  });

  it("surfaces a CAS version mismatch as a typed conflict, with no ledger rows", async () => {
    const fake = buildPrismaFake({ versionMismatch: true, grantedCents: 100_000 });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ApplyClinicCredit,
          { invoiceId: INVOICE_ID, amountCents: 1_000 },
          { idempotencyKey: "credit-apply-cas-1" }
        )
      )
    ).rejects.toMatchObject({ code: APPLY_CLINIC_CREDIT_VERSION_MISMATCH });

    expect(findCall(fake.calls, "payment", "create")).toBeUndefined();
    expect(findCall(fake.calls, "clinicCreditEntry", "create")).toBeUndefined();
  });
});

describe("ApplyClinicCredit — PHI hygiene", () => {
  it("keeps operatorNote out of audit metadata, surfacing only hasOperatorNote", async () => {
    const fake = buildPrismaFake({ grantedCents: 100_000 });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ApplyClinicCredit,
        {
          invoiceId: INVOICE_ID,
          amountCents: 1_000,
          operatorNote: "applying leftover credit from June overpayment",
        },
        { idempotencyKey: "credit-apply-note-1" }
      )
    );

    const audit = findCall(fake.calls, "auditLog", "create");
    // Stringify only `metadata` — the full audit row carries a BigInt
    // chain seq that JSON.stringify cannot serialize.
    const metadata = (audit!.args as { data: { metadata: unknown } }).data.metadata;
    const metadataJson = JSON.stringify(metadata);
    expect(metadataJson).not.toContain("leftover credit from June");
    expect(metadataJson).toContain('"hasOperatorNote":true');
  });
});
