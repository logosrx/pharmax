#!/usr/bin/env tsx
// scripts/operations/backfill-payment-ledger.ts
//
// One-time (idempotent, re-runnable) backfill of the append-only
// `payment` ledger from pre-ledger financial history.
//
// The payment ledger shipped AFTER invoices started collecting and
// refunding money, so history lives only in the projection columns
// and the CREDIT invoice lines:
//
//   - PAYMENT rows: every PAID invoice with `amountPaidCents > 0`
//     that has NO ledger PAYMENT row yet gets one, keyed
//     `backfill-paid:{invoiceId}` (the original Stripe event id of
//     the historical `invoice.paid` webhook is not recoverable from
//     the invoice row; the deterministic key keeps re-runs
//     idempotent). `occurredAt` = the invoice's `paidAt`.
//
//   - REFUND rows: every CREDIT line keyed `stripe-refund:{id}`
//     whose key has no ledger row yet gets one with the SAME
//     `paymentEventKey` — the natural key the live writers use, so
//     the backfill and the live paths converge on one row per
//     refund. Lines whose write-time metadata says the refund was
//     still `pending` are SKIPPED (money had not moved when the
//     line was written; if it settled later, RecordRefundReceived
//     already wrote the ledger row and the key-dedupe excludes the
//     line here — a line that reaches the planner as pending is
//     still unsettled and the settle webhook owns its row).
//
// Deliberate non-behaviors:
//
//   - NO `billing.payment.recorded.v1` outbox events are emitted.
//     Consumers of that stream expect FRESH settles (notifications,
//     activity feeds); replaying years of history into it would be
//     wrong. Backfilled rows are marked `metadata.source =
//     "backfill-payment-ledger"` so reports can discriminate if
//     they ever need to.
//   - NO invoice mutation of any kind. This script only appends
//     ledger rows.
//
// Race-safety vs. live traffic:
//
//   - A concurrent `invoice.paid` replay short-circuits on the
//     already-PAID invoice and writes no ledger row — the backfill
//     row cannot be double-counted.
//   - A concurrent refund settle converges with the backfill on the
//     shared `stripe-refund:{id}` unique key (P2002 → skipped).
//
// Usage:
//   # Dry-run (always safe) — shows what WOULD be inserted:
//   pnpm payments:backfill
//
//   # Execute (optionally scoped to one org):
//   pnpm payments:backfill -- --yes [--org=<uuid>]
//
// Required env:
//   DATABASE_URL   Postgres connection string.
//
// Exits:
//   0  dry-run printed, or backfill completed (zero candidates is
//      success — the tool is idempotent by construction).
//   1  bad arguments.
//
// PHI: none. Invoice ids, cents amounts, Stripe ids, timestamps.

import { parseArgs } from "node:util";

import { insertPaymentLedgerRow, type PaymentLedgerRowInput } from "@pharmax/billing";
import {
  InvoiceLineKind,
  InvoiceStatus,
  PaymentKind,
  PaymentMethod,
  prisma,
} from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";

const USAGE = `
Usage:
  pnpm payments:backfill                      # dry-run (safe)
  pnpm payments:backfill -- --yes [--org=<uuid>]

Required env:
  DATABASE_URL   Postgres connection string.
`.trim();

export const STRIPE_REFUND_KEY_PREFIX = "stripe-refund:";
export const BACKFILL_PAID_KEY_PREFIX = "backfill-paid:";
export const BACKFILL_METADATA_SOURCE = "backfill-payment-ledger";

// ---------------------------------------------------------------------------
// Pure planning helpers (exported for tests).
// ---------------------------------------------------------------------------

export interface PaidInvoiceCandidate {
  readonly id: string;
  readonly organizationId: string;
  readonly clinicId: string;
  readonly currency: string;
  readonly amountPaidCents: number;
  readonly paidAt: Date | null;
  readonly updatedAt: Date;
  readonly stripeChargeId: string | null;
  readonly stripeInvoiceId: string | null;
}

/**
 * Plan the PAYMENT ledger row for a PAID pre-ledger invoice. The
 * caller has already established the invoice has no PAYMENT row.
 */
export function planPaymentBackfillRow(invoice: PaidInvoiceCandidate): PaymentLedgerRowInput {
  return {
    organizationId: invoice.organizationId,
    clinicId: invoice.clinicId,
    invoiceId: invoice.id,
    kind: PaymentKind.PAYMENT,
    method: PaymentMethod.STRIPE,
    amountCents: invoice.amountPaidCents,
    currency: invoice.currency,
    paymentEventKey: `${BACKFILL_PAID_KEY_PREFIX}${invoice.id}`,
    ...(invoice.stripeChargeId !== null ? { stripeChargeId: invoice.stripeChargeId } : {}),
    // paidAt is set by MarkInvoicePaid on every transition; the
    // updatedAt fallback covers rows from before that command
    // existed (or manual DB fixes).
    occurredAt: invoice.paidAt ?? invoice.updatedAt,
    metadata: {
      source: BACKFILL_METADATA_SOURCE,
      stripeInvoiceId: invoice.stripeInvoiceId,
    },
  };
}

export interface RefundLineCandidate {
  readonly id: string;
  readonly invoiceId: string;
  readonly organizationId: string;
  readonly clinicId: string;
  readonly amountCents: number;
  readonly billingEventKey: string;
  readonly metadata: unknown;
  readonly createdAt: Date;
  /** Currency of the parent invoice (lines don't carry one). */
  readonly invoiceCurrency: string;
}

export type RefundBackfillPlan =
  | { readonly kind: "row"; readonly row: PaymentLedgerRowInput }
  | { readonly kind: "skip-pending" };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Plan the REFUND ledger row for a `stripe-refund:*` CREDIT line
 * whose key has no ledger row. Lines written while the refund was
 * still `pending` are skipped — the settle webhook owns their row.
 */
export function planRefundBackfillRow(line: RefundLineCandidate): RefundBackfillPlan {
  const metadata = asRecord(line.metadata);
  if (metadata["stripeStatus"] === "pending") {
    return { kind: "skip-pending" };
  }

  const stripeRefundId = line.billingEventKey.slice(STRIPE_REFUND_KEY_PREFIX.length);
  const refundedAtRaw = asOptionalString(metadata["refundedAt"]);
  const refundedAt = refundedAtRaw !== undefined ? new Date(refundedAtRaw) : undefined;
  const stripeChargeId = asOptionalString(metadata["stripeChargeId"]);
  const stripeEventId = asOptionalString(metadata["stripeEventId"]);

  return {
    kind: "row",
    row: {
      organizationId: line.organizationId,
      clinicId: line.clinicId,
      invoiceId: line.invoiceId,
      kind: PaymentKind.REFUND,
      method: PaymentMethod.STRIPE,
      // Lines store refunds as negative amounts; the ledger is
      // always positive with direction in `kind`.
      amountCents: Math.abs(line.amountCents),
      currency: line.invoiceCurrency,
      paymentEventKey: line.billingEventKey,
      stripeRefundId,
      ...(stripeChargeId !== undefined ? { stripeChargeId } : {}),
      ...(stripeEventId !== undefined ? { stripeEventId } : {}),
      // Write-time metadata carries Stripe's settle timestamp for
      // webhook-recorded refunds; operator-initiated lines don't,
      // so the line's own createdAt is the best available anchor.
      occurredAt:
        refundedAt !== undefined && !Number.isNaN(refundedAt.getTime())
          ? refundedAt
          : line.createdAt,
      metadata: {
        source: BACKFILL_METADATA_SOURCE,
        invoiceLineId: line.id,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// CLI plumbing.
// ---------------------------------------------------------------------------

interface ParsedCli {
  readonly execute: boolean;
  readonly organizationId?: string;
}

export function parseCli(argv: ReadonlyArray<string>): ParsedCli | { readonly error: string } {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== "--"),
    options: {
      yes: { type: "boolean" },
      org: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help === true) {
    return { error: USAGE };
  }

  return {
    execute: values.yes === true,
    ...(typeof values.org === "string" ? { organizationId: values.org } : {}),
  };
}

/** Bounded per-query page; the loop pages until exhaustion. */
const SCAN_PAGE_SIZE = 500;

async function collectPaymentCandidates(
  organizationId: string | undefined
): Promise<PaidInvoiceCandidate[]> {
  const candidates: PaidInvoiceCandidate[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.invoice.findMany({
      where: {
        status: InvoiceStatus.PAID,
        amountPaidCents: { gt: 0 },
        payments: { none: { kind: PaymentKind.PAYMENT } },
        ...(organizationId !== undefined ? { organizationId } : {}),
      },
      select: {
        id: true,
        organizationId: true,
        clinicId: true,
        currency: true,
        amountPaidCents: true,
        paidAt: true,
        updatedAt: true,
        stripeChargeId: true,
        stripeInvoiceId: true,
      },
      orderBy: { id: "asc" },
      take: SCAN_PAGE_SIZE,
      ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    candidates.push(...page);
    if (page.length < SCAN_PAGE_SIZE) return candidates;
    cursor = page[page.length - 1]!.id;
  }
}

async function collectRefundCandidates(
  organizationId: string | undefined
): Promise<RefundLineCandidate[]> {
  const candidates: RefundLineCandidate[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.invoiceLine.findMany({
      where: {
        kind: InvoiceLineKind.CREDIT,
        billingEventKey: { startsWith: STRIPE_REFUND_KEY_PREFIX },
        ...(organizationId !== undefined ? { organizationId } : {}),
      },
      select: {
        id: true,
        invoiceId: true,
        organizationId: true,
        clinicId: true,
        amountCents: true,
        billingEventKey: true,
        metadata: true,
        createdAt: true,
        invoice: { select: { currency: true } },
      },
      orderBy: { id: "asc" },
      take: SCAN_PAGE_SIZE,
      ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const keys = page
      .map((line) => line.billingEventKey)
      .filter((key): key is string => key !== null);
    const existing = await prisma.payment.findMany({
      where: { paymentEventKey: { in: keys } },
      select: { paymentEventKey: true },
    });
    const existingKeys = new Set(existing.map((p) => p.paymentEventKey));

    for (const line of page) {
      if (line.billingEventKey === null || existingKeys.has(line.billingEventKey)) continue;
      candidates.push({
        id: line.id,
        invoiceId: line.invoiceId,
        organizationId: line.organizationId,
        clinicId: line.clinicId,
        amountCents: line.amountCents,
        billingEventKey: line.billingEventKey,
        metadata: line.metadata,
        createdAt: line.createdAt,
        invoiceCurrency: line.invoice.currency,
      });
    }
    if (page.length < SCAN_PAGE_SIZE) return candidates;
    cursor = page[page.length - 1]!.id;
  }
}

interface BackfillSummary {
  paymentRows: number;
  paymentCents: number;
  refundRows: number;
  refundCents: number;
  refundsSkippedPending: number;
  raced: number;
}

async function run(input: {
  execute: boolean;
  organizationId: string | undefined;
}): Promise<BackfillSummary> {
  return withSystemContext("scripts:backfill-payment-ledger", async () => {
    const summary: BackfillSummary = {
      paymentRows: 0,
      paymentCents: 0,
      refundRows: 0,
      refundCents: 0,
      refundsSkippedPending: 0,
      raced: 0,
    };

    const paidInvoices = await collectPaymentCandidates(input.organizationId);
    for (const invoice of paidInvoices) {
      const row = planPaymentBackfillRow(invoice);
      summary.paymentRows += 1;
      summary.paymentCents += row.amountCents;
      if (input.execute) {
        const result = await insertPaymentLedgerRow(prisma, row);
        if (!result.created) summary.raced += 1;
      }
    }

    const refundLines = await collectRefundCandidates(input.organizationId);
    for (const line of refundLines) {
      const plan = planRefundBackfillRow(line);
      if (plan.kind === "skip-pending") {
        summary.refundsSkippedPending += 1;
        continue;
      }
      summary.refundRows += 1;
      summary.refundCents += plan.row.amountCents;
      if (input.execute) {
        const result = await insertPaymentLedgerRow(prisma, plan.row);
        if (!result.created) summary.raced += 1;
      }
    }

    return summary;
  });
}

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  const scope = parsed.organizationId !== undefined ? ` (org ${parsed.organizationId})` : "";
  console.log(
    parsed.execute
      ? `Backfilling payment ledger${scope}…`
      : `DRY-RUN — no rows will be written${scope}. Re-run with --yes to execute.`
  );

  const summary = await run({
    execute: parsed.execute,
    organizationId: parsed.organizationId,
  });

  const verb = parsed.execute ? "inserted" : "would insert";
  console.log(
    [
      "",
      `PAYMENT rows ${verb}: ${summary.paymentRows} (${summary.paymentCents} cents)`,
      `REFUND rows ${verb}:  ${summary.refundRows} (${summary.refundCents} cents)`,
      `Refund lines skipped (still pending — settle webhook owns them): ${summary.refundsSkippedPending}`,
      ...(parsed.execute
        ? [`Races converged on existing rows (already settled live): ${summary.raced}`]
        : []),
      "",
      parsed.execute
        ? "Done. Re-running is safe — every key is deterministic and unique."
        : "Dry-run complete.",
    ].join("\n")
  );
}

// Only execute when run as a CLI (tests import the pure helpers).
const isDirectRun = process.argv[1]?.includes("backfill-payment-ledger") ?? false;
if (isDirectRun) {
  main()
    .catch((cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : String(cause));
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
