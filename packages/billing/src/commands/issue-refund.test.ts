// IssueRefund contract tests.
//
// Surface:
//   - Happy path: Stripe port called with idempotency key, negative
//     line written, totals decremented, outbox emitted.
//   - Partial refund: amountCents < amountPaid, residual stays
//     refundable for follow-up calls.
//   - Multi-call: a prior refund line counts against the
//     `remainingRefundable` budget; second call > remaining fails.
//   - Guards: invoice not PAID, no stripeChargeId linked, amount
//     ≤ 0, amount > paid.
//   - Stripe port unconfigured → BILLING_REFUND_NOT_CONFIGURED.
//   - PHI: operatorNote redacted from audit + outbox metadata
//     (we surface only `hasOperatorNote: boolean`).

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

import { configureBilling, resetBillingConfigurationForTests } from "../configure.js";
import type {
  StripeRefundPort,
  StripeRefundRequest,
  StripeRefundResult,
} from "../ports/stripe-refund-port.js";

import {
  ISSUE_REFUND_AMOUNT_EXCEEDS_PAID,
  ISSUE_REFUND_CHARGE_NOT_LINKED,
  ISSUE_REFUND_INVOICE_NOT_FOUND,
  ISSUE_REFUND_INVOICE_NOT_PAID,
  IssueRefund,
} from "./issue-refund.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const STRIPE_CHARGE_ID = "ch_TestCharge";
const STRIPE_INVOICE_ID = "in_TestInvoice";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.BILLING_ISSUE_REFUND]),
  },
];

interface FakeInvoice {
  id: string;
  clinicId: string;
  status: InvoiceStatus;
  currency: string;
  amountPaidCents: number;
  amountDueCents: number;
  stripeChargeId: string | null;
  stripeInvoiceId: string | null;
  invoiceNumber: string;
}

interface FakeOverrides {
  invoice?: FakeInvoice | null;
  priorRefundLines?: ReadonlyArray<{ amountCents: number }>;
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

const defaultInvoice = (): FakeInvoice => ({
  id: INVOICE_ID,
  clinicId: CLINIC_ID,
  status: InvoiceStatus.PAID,
  currency: "usd",
  amountPaidCents: 15000,
  amountDueCents: 0,
  stripeChargeId: STRIPE_CHARGE_ID,
  stripeInvoiceId: STRIPE_INVOICE_ID,
  invoiceNumber: "INV-2026-05-0c0c0c0c",
});

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const invoice = overrides.invoice === undefined ? defaultInvoice() : overrides.invoice;
  const priorLines = overrides.priorRefundLines ?? [];

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
    invoiceLine: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoiceLine", op: "findMany", args });
        return priorLines.map((l) => ({ amountCents: -Math.abs(l.amountCents) }));
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoiceLine", op: "create", args });
        return { id: "line-refund-1" };
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
    idempotencyKey: { create: vi.fn(async () => ({ ok: true })) },
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
    clock: clock.createFrozenClock(new Date("2026-06-01T10:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

function stubPort(result?: StripeRefundResult): StripeRefundPort & {
  calls: StripeRefundRequest[];
} {
  const calls: StripeRefundRequest[] = [];
  const port: StripeRefundPort = {
    async issueRefund(req) {
      calls.push(req);
      return (
        result ?? {
          stripeRefundId: "re_TestRefund1",
          stripeStatus: "succeeded",
          amountCents: req.amountCents,
        }
      );
    },
  };
  return Object.assign(port, { calls });
}

const ctxFor = () =>
  buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetBillingConfigurationForTests();
});

describe("IssueRefund — happy path", () => {
  it("calls Stripe, writes a negative line, decrements totals, emits the v1 event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    const port = stubPort();
    configureBilling({ stripeRefundPort: port });

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        IssueRefund,
        { invoiceId: INVOICE_ID, amountCents: 5000 },
        { idempotencyKey: "refund-1" }
      )
    );

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({
      pharmaxInvoiceId: INVOICE_ID,
      stripeChargeId: STRIPE_CHARGE_ID,
      amountCents: 5000,
      reason: "requested_by_customer",
    });
    expect(port.calls[0]?.pharmaxRefundKey).toMatch(/^pharmax-refund:/);

    expect(out).toMatchObject({
      stripeRefundId: "re_TestRefund1",
      stripeStatus: "succeeded",
      amountCents: 5000,
      creditAmountCents: -5000,
      amountDueCentsAfter: -5000,
    });

    const lineCreate = fake.calls.find((c) => c.table === "invoiceLine" && c.op === "create");
    const lineData = (lineCreate!.args as { data: Record<string, unknown> }).data;
    expect(lineData["amountCents"]).toBe(-5000);
    expect(lineData["billingEventKey"]).toBe("stripe-refund:re_TestRefund1");
    expect(lineData["kind"]).toBe("CREDIT");

    const invoiceUpdate = fake.calls.find((c) => c.table === "invoice" && c.op === "update");
    const updateData = (invoiceUpdate!.args as { data: Record<string, unknown> }).data;
    expect(updateData["amountDueCents"]).toEqual({ decrement: 5000 });
    expect(updateData["version"]).toEqual({ increment: 1 });

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (outboxCalls[0]!.args as { data: Array<{ eventType: string }> }).data;
    expect(outboxData[0]?.eventType).toBe("billing.invoice.refunded.v1");
  });

  it("counts prior refunds against the remaining-refundable budget", async () => {
    const fake = buildPrismaFake({
      priorRefundLines: [{ amountCents: 8000 }],
    });
    configureBus(fake.client);
    configureBilling({ stripeRefundPort: stubPort() });

    // amountPaid=15000, prior=8000, remaining=7000; 5000 ≤ 7000 → ok
    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        IssueRefund,
        { invoiceId: INVOICE_ID, amountCents: 5000 },
        { idempotencyKey: "refund-partial-ok" }
      )
    );
    expect(out.amountCents).toBe(5000);
  });
});

describe("IssueRefund — guards", () => {
  it("throws ISSUE_REFUND_INVOICE_NOT_FOUND on tenancy miss", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);
    configureBilling({ stripeRefundPort: stubPort() });

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          IssueRefund,
          { invoiceId: INVOICE_ID, amountCents: 1000 },
          { idempotencyKey: "nf" }
        )
      )
    ).rejects.toMatchObject({ code: ISSUE_REFUND_INVOICE_NOT_FOUND });
  });

  it("throws ISSUE_REFUND_INVOICE_NOT_PAID when invoice is not PAID", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.OPEN },
    });
    configureBus(fake.client);
    configureBilling({ stripeRefundPort: stubPort() });

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          IssueRefund,
          { invoiceId: INVOICE_ID, amountCents: 1000 },
          { idempotencyKey: "not-paid" }
        )
      )
    ).rejects.toMatchObject({ code: ISSUE_REFUND_INVOICE_NOT_PAID });
  });

  it("throws ISSUE_REFUND_CHARGE_NOT_LINKED when no stripeChargeId", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), stripeChargeId: null },
    });
    configureBus(fake.client);
    configureBilling({ stripeRefundPort: stubPort() });

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          IssueRefund,
          { invoiceId: INVOICE_ID, amountCents: 1000 },
          { idempotencyKey: "no-charge" }
        )
      )
    ).rejects.toMatchObject({ code: ISSUE_REFUND_CHARGE_NOT_LINKED });
  });

  it("throws ISSUE_REFUND_AMOUNT_EXCEEDS_PAID when refund > remaining refundable", async () => {
    const fake = buildPrismaFake({
      priorRefundLines: [{ amountCents: 13000 }],
    });
    configureBus(fake.client);
    configureBilling({ stripeRefundPort: stubPort() });

    // amountPaid=15000, prior=13000, remaining=2000; 5000 > 2000 → fail
    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          IssueRefund,
          { invoiceId: INVOICE_ID, amountCents: 5000 },
          { idempotencyKey: "exceeds" }
        )
      )
    ).rejects.toMatchObject({ code: ISSUE_REFUND_AMOUNT_EXCEEDS_PAID });
  });

  it("throws BILLING_REFUND_NOT_CONFIGURED when port is null (no STRIPE_SECRET_KEY)", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    configureBilling({ stripeRefundPort: null });

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          IssueRefund,
          { invoiceId: INVOICE_ID, amountCents: 1000 },
          { idempotencyKey: "unconfigured" }
        )
      )
    ).rejects.toMatchObject({ code: "BILLING_REFUND_NOT_CONFIGURED" });
  });
});

describe("IssueRefund — PHI invariant", () => {
  it("redacts operatorNote from audit + outbox; surfaces only hasOperatorNote", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);
    configureBilling({ stripeRefundPort: stubPort() });

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        IssueRefund,
        {
          invoiceId: INVOICE_ID,
          amountCents: 1000,
          operatorNote: "Goodwill refund for clinic 2026-Q2 service issue.",
        },
        { idempotencyKey: "refund-phi" }
      )
    );

    const auditCalls = fake.calls.filter((c) => c.table === "auditLog" && c.op === "create");
    const auditMetadata = (auditCalls[0]!.args as { data: { metadata: Record<string, unknown> } })
      .data.metadata;
    expect(auditMetadata["hasOperatorNote"]).toBe(true);
    expect(JSON.stringify(auditMetadata)).not.toContain("2026-Q2 service issue");

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxPayload = (
      outboxCalls[0]!.args as { data: Array<{ payload: Record<string, unknown> }> }
    ).data[0]!.payload;
    expect(JSON.stringify(outboxPayload)).not.toContain("2026-Q2 service issue");
  });
});
