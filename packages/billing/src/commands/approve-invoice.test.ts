// ApproveInvoice contract tests.
//
// Surface:
//   - Happy path: DRAFT unapproved → approval stamp written via CAS
//     (approvedVersion === new version), emits
//     billing.invoice.approved.v1 with the totals snapshot.
//   - Already-approved (fresh stamp): short-circuits with
//     `alreadyApproved: true` — no mutation, no outbox emit, tiny
//     audit row.
//   - Stale re-approval: a line landed after the previous review
//     (approvedVersion < version) → full re-approval; audit metadata
//     records the superseded stamp.
//   - Guards: not-in-tenancy → APPROVE_INVOICE_NOT_FOUND; non-DRAFT
//     → APPROVE_INVOICE_INVALID_STATUS; zero lines →
//     APPROVE_INVOICE_EMPTY; CAS miss →
//     APPROVE_INVOICE_VERSION_MISMATCH.
//   - PHI hygiene: `approvalNote` never reaches audit metadata or the
//     outbox payload; only `hasApprovalNote` does.

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
  APPROVE_INVOICE_EMPTY,
  APPROVE_INVOICE_INVALID_STATUS,
  APPROVE_INVOICE_NOT_FOUND,
  APPROVE_INVOICE_VERSION_MISMATCH,
  ApproveInvoice,
} from "./approve-invoice.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const PRIOR_APPROVER_ID = "00000000-0000-4000-8000-000000000010";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";

const FROZEN_NOW = new Date("2026-05-31T20:00:00.000Z");

const grants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.BILLING_APPROVE_INVOICE]),
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
  approvedAt: Date | null;
  approvedByUserId: string | null;
  approvedVersion: number | null;
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
  approvedAt: null,
  approvedByUserId: null,
  approvedVersion: null,
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
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-1" };
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
    idempotencyKey: {
      create: vi.fn(async () => ({ ok: true })),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
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
    clock: clock.createFrozenClock(FROZEN_NOW),
    logger: logger.noopLogger,
  });
}

const ctxFor = () =>
  buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });

function findAudit(calls: FakeCall[], action: string): Record<string, unknown> | null {
  const call = calls.find(
    (c) =>
      c.table === "auditLog" &&
      c.op === "create" &&
      (c.args as { data: { action: string } }).data.action === action
  );
  if (call === undefined) return null;
  return (call.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
}

function outboxEvents(
  calls: FakeCall[]
): Array<{ eventType: string; payload: Record<string, unknown> }> {
  return calls
    .filter((c) => c.table === "eventOutbox" && c.op === "createMany")
    .flatMap(
      (c) =>
        (c.args as { data: Array<{ eventType: string; payload: Record<string, unknown> }> }).data
    );
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

describe("ApproveInvoice — happy path", () => {
  it("stamps the approval anchored to the post-CAS version and emits the v1 event", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveInvoice, { invoiceId: INVOICE_ID }, { idempotencyKey: "app-1" })
    );

    expect(out).toMatchObject({
      invoiceId: INVOICE_ID,
      status: "DRAFT",
      lineCount: 3,
      totalCents: 15000,
      approvedByUserId: USER_ID,
      approvedVersion: 4,
      version: 4,
      alreadyApproved: false,
    });
    // The invariant FinalizeInvoice checks: stamp anchored to the
    // CURRENT version at commit time.
    expect(out.approvedVersion).toBe(out.version);

    const cas = fake.calls.find((c) => c.table === "invoice" && c.op === "updateMany");
    expect(cas).toBeDefined();
    const casArgs = cas!.args as {
      where: { id: string; version: number };
      data: Record<string, unknown>;
    };
    expect(casArgs.where.version).toBe(3);
    expect(casArgs.data["approvedVersion"]).toBe(4);
    expect(casArgs.data["version"]).toBe(4);
    expect(casArgs.data["approvedByUserId"]).toBe(USER_ID);
    // Approval is NOT a state transition — status untouched.
    expect(casArgs.data["status"]).toBeUndefined();

    const events = outboxEvents(fake.calls);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("billing.invoice.approved.v1");
    expect(events[0]?.payload).toMatchObject({
      invoiceId: INVOICE_ID,
      approvedByUserId: USER_ID,
      approvedVersion: 4,
      totalCents: 15000,
      lineCount: 3,
    });
  });

  it("re-approves a STALE stamp and records the superseded approval in audit metadata", async () => {
    const fake = buildPrismaFake({
      invoice: {
        ...defaultInvoice(),
        approvedAt: new Date("2026-05-30T10:00:00.000Z"),
        approvedByUserId: PRIOR_APPROVER_ID,
        approvedVersion: 2, // line landed after → version is now 3
        version: 3,
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveInvoice, { invoiceId: INVOICE_ID }, { idempotencyKey: "app-stale" })
    );

    expect(out.alreadyApproved).toBe(false);
    expect(out.approvedVersion).toBe(4);

    const meta = findAudit(fake.calls, "billing.invoice.approved");
    expect(meta).not.toBeNull();
    expect(meta!["supersededApproval"]).toMatchObject({
      approvedByUserId: PRIOR_APPROVER_ID,
      approvedVersion: 2,
    });
    expect(outboxEvents(fake.calls)).toHaveLength(1);
  });
});

describe("ApproveInvoice — idempotency", () => {
  it("short-circuits with alreadyApproved=true when the current revision is already approved", async () => {
    const approvedAt = new Date("2026-05-30T10:00:00.000Z");
    const fake = buildPrismaFake({
      invoice: {
        ...defaultInvoice(),
        approvedAt,
        approvedByUserId: PRIOR_APPROVER_ID,
        approvedVersion: 3, // fresh: equals version
        version: 3,
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(ApproveInvoice, { invoiceId: INVOICE_ID }, { idempotencyKey: "app-rep" })
    );

    expect(out).toMatchObject({
      alreadyApproved: true,
      approvedByUserId: PRIOR_APPROVER_ID,
      approvedVersion: 3,
      version: 3,
    });
    expect(out.approvedAt).toBe(approvedAt.toISOString());
    expect(fake.calls.filter((c) => c.table === "invoice" && c.op === "updateMany")).toHaveLength(
      0
    );
    expect(outboxEvents(fake.calls)).toHaveLength(0);
    expect(findAudit(fake.calls, "billing.invoice.approve.skipped")).not.toBeNull();
  });
});

describe("ApproveInvoice — guards", () => {
  it("throws APPROVE_INVOICE_NOT_FOUND when the invoice is not in the tenancy", async () => {
    const fake = buildPrismaFake({ invoice: null });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(ApproveInvoice, { invoiceId: INVOICE_ID }, { idempotencyKey: "app-nf" })
      )
    ).rejects.toMatchObject({ code: APPROVE_INVOICE_NOT_FOUND });
  });

  it.each([
    InvoiceStatus.OPEN,
    InvoiceStatus.PAID,
    InvoiceStatus.VOID,
    InvoiceStatus.UNCOLLECTIBLE,
  ])("throws APPROVE_INVOICE_INVALID_STATUS for %s invoices", async (status) => {
    const fake = buildPrismaFake({ invoice: { ...defaultInvoice(), status } });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(
          ApproveInvoice,
          { invoiceId: INVOICE_ID },
          { idempotencyKey: `app-st-${status}` }
        )
      )
    ).rejects.toMatchObject({ code: APPROVE_INVOICE_INVALID_STATUS });
  });

  it("throws APPROVE_INVOICE_EMPTY when the invoice has zero lines", async () => {
    const fake = buildPrismaFake({
      invoice: { ...defaultInvoice(), _count: { lines: 0 } },
    });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(ApproveInvoice, { invoiceId: INVOICE_ID }, { idempotencyKey: "app-empty" })
      )
    ).rejects.toMatchObject({ code: APPROVE_INVOICE_EMPTY });
  });

  it("throws APPROVE_INVOICE_VERSION_MISMATCH on CAS miss", async () => {
    const fake = buildPrismaFake({ casCount: 0 });
    configureBus(fake.client);

    await expect(
      withTenancyContext(ctxFor(), () =>
        executeCommand(ApproveInvoice, { invoiceId: INVOICE_ID }, { idempotencyKey: "app-cas" })
      )
    ).rejects.toMatchObject({ code: APPROVE_INVOICE_VERSION_MISMATCH });
  });
});

describe("ApproveInvoice — PHI hygiene", () => {
  it("keeps the approvalNote out of audit metadata and the outbox payload", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        ApproveInvoice,
        { invoiceId: INVOICE_ID, approvalNote: "checked totals against the May contract" },
        { idempotencyKey: "app-note" }
      )
    );

    const meta = findAudit(fake.calls, "billing.invoice.approved");
    expect(meta).not.toBeNull();
    expect(meta!["hasApprovalNote"]).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("May contract");

    const events = outboxEvents(fake.calls);
    expect(JSON.stringify(events[0]?.payload)).not.toContain("May contract");
  });
});
