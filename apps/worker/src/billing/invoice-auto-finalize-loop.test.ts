// Unit tests for the daily period-boundary invoice auto-finalize loop.
//
// Drives the real `createInvoiceAutoFinalizeLoop` against a
// fixture-driven fake Prisma and an injected dispatch fake (the
// command itself has its own contract tests in @pharmax/billing).
// Focus areas:
//
//   - Only period-ended DRAFTs reach the scan (query shape).
//   - Fresh-approved invoices are dispatched; everything else is
//     classified: awaiting_review / stale_approval / empty_draft.
//   - alreadyFinalized dispatch results are tallied separately.
//   - A dispatch failure doesn't stop the remaining invoices.
//   - One org's scan failure doesn't stop the remaining orgs.
//   - Cursor pagination visits every candidate.
//   - The configured daysUntilDue rides along on every dispatch.

import { InvoiceStatus, type PrismaClient } from "@pharmax/database";
import { logger as loggerNs } from "@pharmax/platform-core";
import { describe, expect, it, vi } from "vitest";

import {
  createInvoiceAutoFinalizeLoop,
  type AutoFinalizeDispatch,
} from "./invoice-auto-finalize-loop.js";

const ORG_A = "11111111-1111-7111-a111-111111111111";
const ORG_B = "22222222-2222-7222-a222-222222222222";

const logger = loggerNs.createPinoLogger({
  service: "test-invoice-auto-finalize",
  level: "error",
});

const fixedNow = new Date("2026-08-01T04:10:00.000Z");
const APPROVED_AT = new Date("2026-07-28T15:00:00.000Z");

interface FakeInvoice {
  readonly id: string;
  readonly organizationId: string;
  readonly invoiceNumber: string;
  readonly approvedAt: Date | null;
  readonly approvedVersion: number | null;
  readonly version: number;
  readonly lines: number;
}

let invoiceSeq = 0;
function inv(
  organizationId: string,
  overrides: Partial<Omit<FakeInvoice, "organizationId">> = {}
): FakeInvoice {
  invoiceSeq += 1;
  const id = `33333333-3333-7333-a333-${String(invoiceSeq).padStart(12, "0")}`;
  return {
    id,
    organizationId,
    invoiceNumber: `INV-2026-07-${invoiceSeq}`,
    approvedAt: APPROVED_AT,
    approvedVersion: 2,
    version: 2,
    lines: 3,
    ...overrides,
  };
}

interface Fixtures {
  readonly orgs: ReadonlyArray<{ readonly id: string; readonly slug: string }>;
  readonly invoices: ReadonlyArray<FakeInvoice>;
  /** When set, invoice.findMany throws for this organizationId. */
  readonly failScanForOrg?: string;
}

function buildPrismaFake(fixtures: Fixtures): { client: PrismaClient; scanArgs: unknown[] } {
  const scanArgs: unknown[] = [];
  const client = {
    organization: {
      findMany: vi.fn(async () => fixtures.orgs),
    },
    invoice: {
      findMany: vi.fn(
        async (args: { where: { organizationId: string; id?: { gt: string } }; take: number }) => {
          scanArgs.push(args);
          if (args.where.organizationId === fixtures.failScanForOrg) {
            throw new Error("relation does not exist");
          }
          const after = args.where.id?.gt ?? "";
          return fixtures.invoices
            .filter((i) => i.organizationId === args.where.organizationId && i.id > after)
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .slice(0, args.take)
            .map((i) => ({
              id: i.id,
              invoiceNumber: i.invoiceNumber,
              approvedAt: i.approvedAt,
              approvedVersion: i.approvedVersion,
              version: i.version,
              _count: { lines: i.lines },
            }));
        }
      ),
    },
  } as unknown as PrismaClient;
  return { client, scanArgs };
}

interface DispatchFakeOptions {
  /** Invoice ids that resolve as alreadyFinalized=true. */
  readonly alreadyFinalizedIds?: ReadonlyArray<string>;
  /** Invoice ids whose dispatch throws. */
  readonly failIds?: ReadonlyArray<string>;
}

function buildDispatchFake(options: DispatchFakeOptions = {}): {
  dispatch: AutoFinalizeDispatch;
  calls: Array<{ organizationId: string; invoiceId: string; daysUntilDue: number }>;
} {
  const calls: Array<{ organizationId: string; invoiceId: string; daysUntilDue: number }> = [];
  const dispatch: AutoFinalizeDispatch = async (input) => {
    calls.push(input);
    if (options.failIds?.includes(input.invoiceId) === true) {
      throw Object.assign(new Error("approval went stale between scan and dispatch"), {
        code: "FINALIZE_INVOICE_APPROVAL_STALE",
      });
    }
    const alreadyFinalized = options.alreadyFinalizedIds?.includes(input.invoiceId) === true;
    return {
      invoiceId: input.invoiceId,
      invoiceNumber: "INV-2026-07-X",
      status: InvoiceStatus.OPEN,
      issuedAt: fixedNow.toISOString(),
      dueAt: new Date("2026-08-31T04:10:00.000Z").toISOString(),
      totalCents: 12_500,
      lineCount: 3,
      version: 3,
      alreadyFinalized,
    };
  };
  return { dispatch, calls };
}

function buildLoop(
  fixtures: Fixtures,
  dispatchOptions: DispatchFakeOptions = {},
  loopOverrides: { pageSize?: number; daysUntilDue?: number } = {}
) {
  const prismaFake = buildPrismaFake(fixtures);
  const dispatchFake = buildDispatchFake(dispatchOptions);
  const loop = createInvoiceAutoFinalizeLoop({
    prisma: prismaFake.client,
    logger,
    pageSize: loopOverrides.pageSize ?? 200,
    daysUntilDue: loopOverrides.daysUntilDue ?? 30,
    dispatchAutoFinalize: dispatchFake.dispatch,
    now: () => fixedNow,
  });
  return { loop, prismaFake, dispatchFake };
}

describe("invoice-auto-finalize loop — scan shape", () => {
  it("scans only period-ended DRAFT invoices, cutoff at the run start", async () => {
    const { loop, prismaFake } = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [inv(ORG_A)],
    });

    await loop.runOnce(fixedNow);

    expect(prismaFake.scanArgs.length).toBeGreaterThan(0);
    expect(prismaFake.scanArgs[0]).toMatchObject({
      where: {
        organizationId: ORG_A,
        status: InvoiceStatus.DRAFT,
        billingPeriodEnd: { lt: fixedNow },
      },
      orderBy: { id: "asc" },
    });
  });
});

describe("invoice-auto-finalize loop — classification", () => {
  it("dispatches fresh-approved invoices and skips the rest by reason", async () => {
    const freshA = inv(ORG_A);
    const freshB = inv(ORG_A);
    const awaiting = inv(ORG_A, { approvedAt: null, approvedVersion: null });
    const stale = inv(ORG_A, { approvedVersion: 1, version: 2 });
    const empty = inv(ORG_A, { lines: 0 });

    const { loop, dispatchFake } = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [freshA, freshB, awaiting, stale, empty],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.invoicesScanned).toBe(5);
    expect(summary.invoicesFinalized).toBe(2);
    expect(summary.invoicesFailed).toBe(0);
    expect(summary.skippedByReason).toEqual({
      awaiting_review: 1,
      stale_approval: 1,
      empty_draft: 1,
    });
    expect(dispatchFake.calls.map((c) => c.invoiceId).sort()).toEqual(
      [freshA.id, freshB.id].sort()
    );
  });

  it("classifies an empty draft as empty_draft even when it was never approved", async () => {
    // Empty wins over awaiting_review: there is nothing to review.
    const emptyUnapproved = inv(ORG_A, { lines: 0, approvedAt: null, approvedVersion: null });
    const { loop, dispatchFake } = buildLoop({
      orgs: [{ id: ORG_A, slug: "org-a" }],
      invoices: [emptyUnapproved],
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.skippedByReason.empty_draft).toBe(1);
    expect(summary.skippedByReason.awaiting_review).toBe(0);
    expect(dispatchFake.calls).toHaveLength(0);
  });

  it("carries the configured daysUntilDue on every dispatch", async () => {
    const fresh = inv(ORG_A);
    const { loop, dispatchFake } = buildLoop(
      { orgs: [{ id: ORG_A, slug: "org-a" }], invoices: [fresh] },
      {},
      { daysUntilDue: 45 }
    );

    await loop.runOnce(fixedNow);

    expect(dispatchFake.calls).toEqual([
      { organizationId: ORG_A, invoiceId: fresh.id, daysUntilDue: 45 },
    ]);
  });
});

describe("invoice-auto-finalize loop — race + failure isolation", () => {
  it("tallies operator-raced invoices as alreadyFinalized, not finalized", async () => {
    const raced = inv(ORG_A);
    const fresh = inv(ORG_A);
    const { loop } = buildLoop(
      { orgs: [{ id: ORG_A, slug: "org-a" }], invoices: [raced, fresh] },
      { alreadyFinalizedIds: [raced.id] }
    );

    const summary = await loop.runOnce(fixedNow);

    expect(summary.invoicesFinalized).toBe(1);
    expect(summary.invoicesAlreadyFinalized).toBe(1);
  });

  it("a dispatch failure doesn't stop the remaining invoices in the org", async () => {
    const failing = inv(ORG_A);
    const fresh = inv(ORG_A);
    const { loop, dispatchFake } = buildLoop(
      { orgs: [{ id: ORG_A, slug: "org-a" }], invoices: [failing, fresh] },
      { failIds: [failing.id] }
    );

    const summary = await loop.runOnce(fixedNow);

    expect(summary.invoicesFailed).toBe(1);
    expect(summary.invoicesFinalized).toBe(1);
    expect(summary.orgsProcessed).toBe(1);
    expect(summary.orgsFailed).toBe(0);
    expect(dispatchFake.calls).toHaveLength(2);
  });

  it("one org's scan failure doesn't stop the remaining orgs", async () => {
    const freshB = inv(ORG_B);
    const { loop } = buildLoop({
      orgs: [
        { id: ORG_A, slug: "org-a" },
        { id: ORG_B, slug: "org-b" },
      ],
      invoices: [freshB],
      failScanForOrg: ORG_A,
    });

    const summary = await loop.runOnce(fixedNow);

    expect(summary.orgsFailed).toBe(1);
    expect(summary.orgsProcessed).toBe(1);
    expect(summary.invoicesFinalized).toBe(1);
  });
});

describe("invoice-auto-finalize loop — pagination", () => {
  it("visits every candidate across pages", async () => {
    const invoices = Array.from({ length: 5 }, () => inv(ORG_A));
    const { loop, dispatchFake } = buildLoop(
      { orgs: [{ id: ORG_A, slug: "org-a" }], invoices },
      {},
      { pageSize: 2 }
    );

    const summary = await loop.runOnce(fixedNow);

    expect(summary.invoicesScanned).toBe(5);
    expect(summary.invoicesFinalized).toBe(5);
    expect(new Set(dispatchFake.calls.map((c) => c.invoiceId)).size).toBe(5);
  });
});
