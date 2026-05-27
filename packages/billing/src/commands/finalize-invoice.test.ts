// FinalizeInvoice contract tests.
//
// Surface:
//   - Happy path: DRAFT → OPEN, CAS bumps version, emits the v1 event
//     with the full snapshot (subtotal/total/lineCount + due dates).
//   - Already-finalized: status !== DRAFT short-circuits with
//     `alreadyFinalized: true`, no mutation, no outbox emit, audit
//     row records the no-op for the timeline.
//   - Empty-invoice guard: zero lines → FINALIZE_INVOICE_EMPTY.
//   - CAS miss (concurrent finalize): FINALIZE_INVOICE_VERSION_MISMATCH.
//   - Not-in-tenancy: FINALIZE_INVOICE_NOT_FOUND.

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
  FINALIZE_INVOICE_EMPTY,
  FINALIZE_INVOICE_NOT_FOUND,
  FINALIZE_INVOICE_VERSION_MISMATCH,
  FinalizeInvoice,
} from "./finalize-invoice.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.BILLING_FINALIZE_INVOICE]),
  },
];

interface FakeInvoiceRow {
  id: string;
  clinicId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: string;
  subtotalCents: number;
  totalCents: number;
  amountDueCents: number;
  issuedAt: Date | null;
  dueAt: Date | null;
  version: number;
  _count: { lines: number };
}

interface FakeOverrides {
  invoice?: FakeInvoiceRow | null;
  casCount?: number;
}

const defaultInvoice = (): FakeInvoiceRow => ({
  id: INVOICE_ID,
  clinicId: CLINIC_ID,
  invoiceNumber: "INV-2026-05-0c0c0c0c",
  status: InvoiceStatus.DRAFT,
  currency: "usd",
  subtotalCents: 15000,
  totalCents: 15000,
  amountDueCents: 15000,
  issuedAt: null,
  dueAt: null,
  version: 3,
  _count: { lines: 3 },
});

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
    clock: clock.createFrozenClock(new Date("2026-05-31T20:00:00.000Z")),
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

describe("FinalizeInvoice — happy path", () => {
  it("transitions DRAFT → OPEN, CAS-bumps version, emits the v1 event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(FinalizeInvoice, { invoiceId: INVOICE_ID }, { idempotencyKey: "fin-1" })
    );

    expect(out).toMatchObject({
      invoiceId: INVOICE_ID,
      status: "OPEN",
      lineCount: 3,
      subtotalCents: 15000,
      totalCents: 15000,
      version: 4,
      alreadyFinalized: false,
    });
    expect(new Date(out.dueAt).getTime()).toBeGreaterThan(new Date(out.issuedAt).getTime());

    const cas = fake.calls.find((c) => c.table === "invoice" && c.op === "updateMany");
    expect(cas).toBeDefined();
    const casArgs = cas!.args as {
      where: { id: string; version: number };
      data: Record<string, unknown>;
    };
    expect(casArgs.where.version).toBe(3);
    expect(casArgs.data["status"]).toBe("OPEN");
    expect(casArgs.data["version"]).toBe(4);

    const outboxCalls = fake.calls.filter(
      (c) => c.table === "eventOutbox" && c.op === "createMany"
    );
    const outboxData = (
      outboxCalls[0]!.args as {
        data: Array<{ eventType: string; payload: Record<string, unknown> }>;
      }
    ).data;
    expect(outboxData[0]?.eventType).toBe("billing.invoice.finalized.v1");
    expect(outboxData[0]?.payload["totalCents"]).toBe(15000);
    expect(outboxData[0]?.payload["lineCount"]).toBe(3);
  });

  it("respects an explicit daysUntilDue", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(
        FinalizeInvoice,
        { invoiceId: INVOICE_ID, daysUntilDue: 7 },
        { idempotencyKey: "fin-2" }
      )
    );

    const due = new Date(out.dueAt);
    const issued = new Date(out.issuedAt);
    expect(due.getTime() - issued.getTime()).toBe(7 * 24 * 60 * 60_000);
  });
});

describe("FinalizeInvoice — idempotency", () => {
  it("short-circuits with alreadyFinalized=true when invoice is already OPEN", async () => {
    const fake = buildPrismaFake({
      invoice: {
        ...defaultInvoice(),
        status: InvoiceStatus.OPEN,
        issuedAt: new Date("2026-05-31T20:00:00.000Z"),
        dueAt: new Date("2026-06-30T20:00:00.000Z"),
        version: 4,
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(FinalizeInvoice, { invoiceId: INVOICE_ID }, { idempotencyKey: "fin-rep" })
    );

    expect(out.alreadyFinalized).toBe(true);
    expect(out.version).toBe(4);
    expect(fake.calls.filter((c) => c.table === "invoice" && c.op === "updateMany")).toHaveLength(
      0
    );
    expect(
      fake.calls.filter((c) => c.table === "eventOutbox" && c.op === "createMany")
    ).toHaveLength(0);
  });
});

describe("FinalizeInvoice — guards", () => {
  it("throws when the invoice is not in the tenancy", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(FinalizeInvoice, { invoiceId: INVOICE_ID }, { idempotencyKey: "fin-nf" })
      )
    ).rejects.toMatchObject({ code: FINALIZE_INVOICE_NOT_FOUND });
  });

  it("throws FINALIZE_INVOICE_EMPTY when the invoice has zero lines", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), _count: { lines: 0 } },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(FinalizeInvoice, { invoiceId: INVOICE_ID }, { idempotencyKey: "fin-empty" })
      )
    ).rejects.toMatchObject({ code: FINALIZE_INVOICE_EMPTY });
  });

  it("throws FINALIZE_INVOICE_VERSION_MISMATCH on CAS miss", async () => {
    const fake = buildPrismaFake({ casCount: 0 });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(FinalizeInvoice, { invoiceId: INVOICE_ID }, { idempotencyKey: "fin-cas" })
      )
    ).rejects.toMatchObject({ code: FINALIZE_INVOICE_VERSION_MISMATCH });
  });
});
