// CreditInvoice contract tests.
//
// Surface:
//   - Happy path: inserts negative-amount line, decrements totals,
//     emits `billing.invoice.credited.v1`.
//   - Each supported kind (CREDIT / DISCOUNT / ADJUSTMENT) round-trips.
//   - VOID invoice → CREDIT_INVOICE_VOIDED.
//   - Credit exceeds invoice total → CREDIT_INVOICE_EXCEEDS_TOTAL.
//   - Not-in-tenancy → CREDIT_INVOICE_NOT_FOUND.
//   - PHI invariant: reasonText is redacted from audit + outbox;
//     only hasReasonText survives.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { InvoiceLineKind, InvoiceStatus, RoleScope } from "@pharmax/database";
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
  CREDIT_INVOICE_EXCEEDS_TOTAL,
  CREDIT_INVOICE_NOT_FOUND,
  CREDIT_INVOICE_VOIDED,
  CreditInvoice,
} from "./credit-invoice.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.BILLING_CREDIT_INVOICE]),
  },
];

interface FakeInvoice {
  id: string;
  clinicId: string;
  status: InvoiceStatus;
  currency: string;
  subtotalCents: number;
  totalCents: number;
  amountDueCents: number;
  invoiceNumber: string;
}

interface FakeOverrides {
  invoice?: FakeInvoice | null;
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
  subtotalCents: 15000,
  totalCents: 15000,
  amountDueCents: 15000,
  invoiceNumber: "INV-2026-05-0c0c0c0c",
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
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "update", args });
        return { id: INVOICE_ID };
      }),
    },
    invoiceLine: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoiceLine", op: "create", args });
        return { id: "line-credit-1" };
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
    clock: clock.createFrozenClock(new Date("2026-05-31T22:00:00.000Z")),
    logger: logger.noopLogger,
  });
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
});

describe("CreditInvoice — happy path", () => {
  it("inserts a negative-amount line, decrements totals, emits the v1 event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CreditInvoice,
        {
          invoiceId: INVOICE_ID,
          amountCents: 2500,
          kind: InvoiceLineKind.CREDIT,
          description: "Goodwill credit",
        },
        { idempotencyKey: "credit-1" }
      )
    );

    expect(out.creditAmountCents).toBe(-2500);
    expect(out.subtotalCentsAfter).toBe(12500);
    expect(out.totalCentsAfter).toBe(12500);
    expect(out.amountDueCentsAfter).toBe(12500);

    // Line is NEGATIVE.
    const lineCreate = fake.calls.find((c) => c.table === "invoiceLine" && c.op === "create");
    const lineData = (lineCreate!.args as { data: Record<string, unknown> }).data;
    expect(lineData["amountCents"]).toBe(-2500);
    expect(lineData["unitAmountCents"]).toBe(-2500);
    expect(lineData["kind"]).toBe("CREDIT");
    expect(String(lineData["billingEventKey"])).toMatch(/^manual-credit:/);

    // Invoice totals atomically decremented via `{ decrement }`.
    const update = fake.calls.find((c) => c.table === "invoice" && c.op === "update");
    const updateData = (update!.args as { data: Record<string, unknown> }).data;
    expect(updateData["subtotalCents"]).toEqual({ decrement: 2500 });
    expect(updateData["totalCents"]).toEqual({ decrement: 2500 });
    expect(updateData["amountDueCents"]).toEqual({ decrement: 2500 });

    // Outbox v1 event.
    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (
      outboxCalls[0]!.args as {
        data: Array<{ eventType: string; payload: Record<string, unknown> }>;
      }
    ).data;
    expect(outboxData[0]?.eventType).toBe("billing.invoice.credited.v1");
    expect(outboxData[0]?.payload["creditAmountCents"]).toBe(-2500);
    expect(outboxData[0]?.payload["totalCentsAfter"]).toBe(12500);
  });

  it.each([[InvoiceLineKind.CREDIT], [InvoiceLineKind.DISCOUNT], [InvoiceLineKind.ADJUSTMENT]])(
    "accepts kind=%s",
    async (kind) => {
      const fake = buildPrismaFake();
      configureBus(fake.client);

      const out = await withTenancyContext(ctxFor(), () =>
        executeCommand(
          CreditInvoice,
          { invoiceId: INVOICE_ID, amountCents: 1000, kind, description: "test" },
          { idempotencyKey: `credit-${kind}` }
        )
      );
      expect(out.creditAmountCents).toBe(-1000);
    }
  );
});

describe("CreditInvoice — guards", () => {
  it("throws when the invoice is not in this tenancy", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          CreditInvoice,
          {
            invoiceId: INVOICE_ID,
            amountCents: 1000,
            kind: InvoiceLineKind.CREDIT,
            description: "test",
          },
          { idempotencyKey: "credit-nf" }
        )
      )
    ).rejects.toMatchObject({ code: CREDIT_INVOICE_NOT_FOUND });
  });

  it("throws when the invoice is VOID", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), status: InvoiceStatus.VOID },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          CreditInvoice,
          {
            invoiceId: INVOICE_ID,
            amountCents: 1000,
            kind: InvoiceLineKind.CREDIT,
            description: "test",
          },
          { idempotencyKey: "credit-void" }
        )
      )
    ).rejects.toMatchObject({ code: CREDIT_INVOICE_VOIDED });
  });

  it("throws CREDIT_INVOICE_EXCEEDS_TOTAL when amount > totalCents", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          CreditInvoice,
          {
            invoiceId: INVOICE_ID,
            amountCents: 20000,
            kind: InvoiceLineKind.CREDIT,
            description: "too much",
          },
          { idempotencyKey: "credit-exceeds" }
        )
      )
    ).rejects.toMatchObject({ code: CREDIT_INVOICE_EXCEEDS_TOTAL });
  });
});

describe("CreditInvoice — PHI invariant", () => {
  it("redacts reasonText from audit + outbox; surfaces only hasReasonText flag", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        CreditInvoice,
        {
          invoiceId: INVOICE_ID,
          amountCents: 1000,
          kind: InvoiceLineKind.CREDIT,
          description: "Goodwill credit",
          reasonText: "Operator-only note about clinic relationship 2026-Q2.",
        },
        { idempotencyKey: "credit-phi" }
      )
    );

    const auditCalls = fake.calls.filter((c) => c.table === "auditLog" && c.op === "create");
    const auditMetadata = (auditCalls[0]!.args as { data: { metadata: Record<string, unknown> } })
      .data.metadata;
    expect(auditMetadata["hasReasonText"]).toBe(true);
    expect(JSON.stringify(auditMetadata)).not.toContain("clinic relationship 2026-Q2");

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxPayload = (
      outboxCalls[0]!.args as { data: Array<{ payload: Record<string, unknown> }> }
    ).data[0]!.payload;
    expect(outboxPayload["hasReasonText"]).toBe(true);
    expect(JSON.stringify(outboxPayload)).not.toContain("clinic relationship 2026-Q2");
  });
});
