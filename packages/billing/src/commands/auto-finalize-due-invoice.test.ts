// AutoFinalizeDueInvoice contract tests.
//
// Surface:
//   - Happy path: period-ended, fresh-approved DRAFT goes OPEN via
//     CAS; audit carries trigger=period-boundary-cron + the approval
//     snapshot; outbox emits billing.invoice.finalized.v1 (identical
//     shape to the operator path, so the Stripe push follows).
//   - Already finalized (operator raced the cron) → short-circuit,
//     no mutation, no outbox.
//   - The machine-only guards: no billingPeriodEnd / period not
//     ended yet.
//   - The SHARED core guards re-fire through this entry point:
//     unapproved, stale approval, empty draft, CAS version miss.
//   - Not found in target org.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InvoiceStatus } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureCommandBus,
  executeSystemCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { withSystemContext } from "@pharmax/tenancy";

import {
  AUTO_FINALIZE_INVOICE_NOT_FOUND,
  AUTO_FINALIZE_NO_BILLING_PERIOD,
  AUTO_FINALIZE_PERIOD_NOT_ENDED,
  AutoFinalizeDueInvoice,
} from "./auto-finalize-due-invoice.js";
import {
  FINALIZE_INVOICE_APPROVAL_STALE,
  FINALIZE_INVOICE_EMPTY,
  FINALIZE_INVOICE_NOT_APPROVED,
  FINALIZE_INVOICE_VERSION_MISMATCH,
} from "../finalize-invoice-core.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const APPROVER_ID = "00000000-0000-4000-8000-000000000009";

// The cron fires 04:10 UTC on Aug 1; the July period ended overnight.
const FROZEN_NOW = new Date("2026-08-01T04:10:00.000Z");
const PERIOD_END = new Date("2026-07-31T23:59:59.999Z");
const APPROVED_AT = new Date("2026-07-28T15:00:00.000Z");

interface FakeInvoiceRow {
  id: string;
  clinicId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: string;
  subtotalCents: number;
  totalCents: number;
  amountDueCents: number;
  billingPeriodEnd: Date | null;
  issuedAt: Date | null;
  dueAt: Date | null;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  approvedVersion: number | null;
  version: number;
  _count: { lines: number };
}

function draftInvoice(overrides: Partial<FakeInvoiceRow> = {}): FakeInvoiceRow {
  return {
    id: INVOICE_ID,
    clinicId: CLINIC_ID,
    invoiceNumber: "INV-2026-07-0c0c0c0c",
    status: InvoiceStatus.DRAFT,
    currency: "usd",
    subtotalCents: 12_500,
    totalCents: 12_500,
    amountDueCents: 12_500,
    billingPeriodEnd: PERIOD_END,
    issuedAt: null,
    dueAt: null,
    approvedAt: APPROVED_AT,
    approvedByUserId: APPROVER_ID,
    approvedVersion: 4,
    version: 4,
    _count: { lines: 3 },
    ...overrides,
  };
}

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  invoice?: FakeInvoiceRow | null;
  /** When set, invoice.updateMany reports zero matched rows (CAS miss). */
  casMiss?: boolean;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const invoice = overrides.invoice === undefined ? draftInvoice() : overrides.invoice;

  const tx = {
    invoice: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "findFirst", args });
        return invoice;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "invoice", op: "updateMany", args });
        return { count: overrides.casMiss === true ? 0 : 1 };
      }),
    },
    commandLog: {
      create: vi.fn(async () => ({ id: "cl-1" })),
      update: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(
        async (args: { where: { organizationId: string }; create: Record<string, unknown> }) => ({
          organizationId: args.where.organizationId,
          ...args.create,
        })
      ),
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
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(FROZEN_NOW),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  const fake = buildPrismaFake({});
  configureBus(fake.client);
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

const validInput = {
  organizationId: ORG_ID,
  invoiceId: INVOICE_ID,
  daysUntilDue: 30,
};

async function run(input = validInput) {
  return await withSystemContext("auto-finalize-test", () =>
    executeSystemCommand(AutoFinalizeDueInvoice, input)
  );
}

function findAudit(calls: FakeCall[]): Record<string, unknown> {
  const call = calls.find((c) => c.table === "auditLog");
  expect(call).toBeDefined();
  return (call!.args as { data: Record<string, unknown> }).data;
}

describe("AutoFinalizeDueInvoice — happy path", () => {
  it("finalizes a period-ended, fresh-approved DRAFT via CAS and emits the finalized event", async () => {
    const fake = buildPrismaFake({});
    configureBus(fake.client);

    const out = await run();

    expect(out.alreadyFinalized).toBe(false);
    expect(out.status).toBe(InvoiceStatus.OPEN);
    expect(out.issuedAt).toBe(FROZEN_NOW.toISOString());
    expect(out.dueAt).toBe(new Date("2026-08-31T04:10:00.000Z").toISOString());
    expect(out.version).toBe(5);
    expect(out.totalCents).toBe(12_500);
    expect(out.lineCount).toBe(3);

    // CAS pinned to the loaded version.
    const cas = fake.calls.find((c) => c.table === "invoice" && c.op === "updateMany");
    expect(cas).toBeDefined();
    const casArgs = cas!.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(casArgs.where).toMatchObject({ id: INVOICE_ID, version: 4 });
    expect(casArgs.data).toMatchObject({ status: InvoiceStatus.OPEN, version: 5 });

    // Audit carries the machine trigger + the human approval it consumed.
    const audit = findAudit(fake.calls);
    expect(audit["action"]).toBe("billing.invoice.auto_finalized");
    expect(audit["organizationId"]).toBe(ORG_ID);
    const metadata = audit["metadata"] as Record<string, unknown>;
    expect(metadata["trigger"]).toBe("period-boundary-cron");
    expect(metadata["billingPeriodEnd"]).toBe(PERIOD_END.toISOString());
    expect(metadata["approvedByUserId"]).toBe(APPROVER_ID);
    expect(metadata["approvedVersion"]).toBe(4);
    expect(metadata["approvedAt"]).toBe(APPROVED_AT.toISOString());

    // Outbox: same billing.invoice.finalized.v1 shape as the operator path.
    const outbox = fake.calls.find((c) => c.table === "eventOutbox");
    expect(outbox).toBeDefined();
    const rows = (outbox!.args as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: "billing.invoice.finalized.v1" });
    expect(rows[0]!["payload"]).toMatchObject({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      invoiceId: INVOICE_ID,
      amountDueCents: 12_500,
      lineCount: 3,
      issuedAt: FROZEN_NOW.toISOString(),
    });
  });
});

describe("AutoFinalizeDueInvoice — already finalized (operator raced the cron)", () => {
  it("short-circuits with alreadyFinalized=true; no mutation, no outbox", async () => {
    const fake = buildPrismaFake({
      invoice: draftInvoice({
        status: InvoiceStatus.OPEN,
        issuedAt: new Date("2026-07-31T18:00:00.000Z"),
        dueAt: new Date("2026-08-30T18:00:00.000Z"),
        version: 5,
      }),
    });
    configureBus(fake.client);

    const out = await run();

    expect(out.alreadyFinalized).toBe(true);
    expect(out.status).toBe(InvoiceStatus.OPEN);
    expect(out.version).toBe(5);
    expect(fake.calls.some((c) => c.op === "updateMany")).toBe(false);
    expect(fake.calls.some((c) => c.table === "eventOutbox")).toBe(false);

    const audit = findAudit(fake.calls);
    expect(audit["action"]).toBe("billing.invoice.auto_finalize.skipped");
  });
});

describe("AutoFinalizeDueInvoice — machine-only guards", () => {
  it("refuses an invoice without a billingPeriodEnd", async () => {
    const fake = buildPrismaFake({ invoice: draftInvoice({ billingPeriodEnd: null }) });
    configureBus(fake.client);
    await expect(run()).rejects.toMatchObject({ code: AUTO_FINALIZE_NO_BILLING_PERIOD });
  });

  it("refuses an invoice whose period has not ended", async () => {
    const fake = buildPrismaFake({
      invoice: draftInvoice({ billingPeriodEnd: new Date("2026-08-31T23:59:59.999Z") }),
    });
    configureBus(fake.client);
    await expect(run()).rejects.toMatchObject({ code: AUTO_FINALIZE_PERIOD_NOT_ENDED });
  });

  it("refuses an invoice missing from the target organization", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);
    await expect(run()).rejects.toMatchObject({ code: AUTO_FINALIZE_INVOICE_NOT_FOUND });
  });
});

describe("AutoFinalizeDueInvoice — shared core guards re-fire here", () => {
  it("never finalizes an unreviewed draft", async () => {
    const fake = buildPrismaFake({
      invoice: draftInvoice({ approvedAt: null, approvedByUserId: null, approvedVersion: null }),
    });
    configureBus(fake.client);
    await expect(run()).rejects.toMatchObject({ code: FINALIZE_INVOICE_NOT_APPROVED });
    expect(fake.calls.some((c) => c.op === "updateMany")).toBe(false);
  });

  it("never finalizes a stale-approved draft (lines landed after the review)", async () => {
    const fake = buildPrismaFake({
      invoice: draftInvoice({ approvedVersion: 3, version: 4 }),
    });
    configureBus(fake.client);
    await expect(run()).rejects.toMatchObject({ code: FINALIZE_INVOICE_APPROVAL_STALE });
    expect(fake.calls.some((c) => c.op === "updateMany")).toBe(false);
  });

  it("never finalizes an empty draft", async () => {
    const fake = buildPrismaFake({ invoice: draftInvoice({ _count: { lines: 0 } }) });
    configureBus(fake.client);
    await expect(run()).rejects.toMatchObject({ code: FINALIZE_INVOICE_EMPTY });
  });

  it("surfaces a CAS miss as the shared version-mismatch conflict", async () => {
    const fake = buildPrismaFake({ casMiss: true });
    configureBus(fake.client);
    await expect(run()).rejects.toMatchObject({ code: FINALIZE_INVOICE_VERSION_MISMATCH });
    expect(fake.calls.some((c) => c.table === "eventOutbox")).toBe(false);
  });
});
