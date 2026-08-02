// Nightly payment-ledger reconciliation verifier (flagship billing,
// slice 3 — after the ledger writes in slice 1 and the historical
// backfill in slice 2).
//
// The `payment` table is the auditable financial ledger; the
// invoice's `amountPaidCents` is the operational projection written
// in the SAME transaction. They can therefore only disagree through
// a bug, a manual DB edit, or an incomplete backfill — all of which
// an enterprise billing platform must DETECT, not assume away. This
// loop is the detection: every night it walks every organization and
// asserts, per invoice:
//
//   1. PAYMENT parity — for every OPEN or PAID invoice with
//      `amountPaidCents > 0`, the sum of PAYMENT ledger rows equals
//      `amountPaidCents`. Zero rows → PAYMENT_ROWS_MISSING (the
//      dominant signal when the backfill has not run yet); a
//      non-zero mismatch → PAYMENT_SUM_MISMATCH. OPEN invoices are
//      in scope because RecordManualPayment writes partial manual
//      collections (check/ACH/wire) that leave the invoice OPEN.
//   2. REFUND parity — the sum of REFUND ledger rows never exceeds
//      the |sum| of `stripe-refund:*` CREDIT lines. Lines exceeding
//      the ledger is EXPECTED (pending refunds write the line first
//      and the ledger row at settlement) and is reported as an
//      informational `unsettledRefund*` tally, not drift.
//   3. Orphan check — no ledger row may reference an invoice in a
//      status that cannot carry money (DRAFT / VOID / UNCOLLECTIBLE).
//      Both ledger writers commit the row in the same tx as the
//      balance mutation on an OPEN/PAID invoice, so any such row
//      means out-of-band writes.
//
// READ-ONLY BY DESIGN. The verifier never "fixes" drift — a nightly
// job silently rewriting financial rows would be indistinguishable
// from the corruption it exists to catch. Detection here, remediation
// through the documented operator paths (`pnpm payments:backfill`
// for missing historical rows; incident process for anything else).
//
// SCHEDULING — 03:30 UTC, after the security jobs (audit verifier
// 01:30, Merkle 02:00, digest 02:30, access review 03:00) so the
// nightly windows don't stack DB scans on top of each other.
//
// PER-ORG ISOLATION — one org's query failure must not stop the
// loop from verifying the next org, mirroring the audit-chain
// verifier. Each org outcome is logged + counted; drift fires the
// `pharmax_payment_ledger_drift_total` counter that the
// PaymentLedgerDriftDetected alert watches.
//
// PHI: none anywhere in this file — invoice ids, invoice numbers,
// cents, and counts only.

import { InvoiceLineKind, InvoiceStatus, PaymentKind, type PrismaClient } from "@pharmax/database";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { getMeter } from "@pharmax/telemetry";
import { withSystemContext } from "@pharmax/tenancy";

import {
  createDailyUtcScheduler,
  type DailyUtcScheduler,
} from "../security/daily-utc-scheduler.js";

type Logger = loggerContract.Logger;

const meter = getMeter("@pharmax/worker.billing");

const reconciliationRunsCounter = meter.createCounter(
  "pharmax_payment_ledger_reconciliation_runs_total",
  {
    description:
      "Nightly payment-ledger reconciliation completions, labelled by per-org outcome (clean | drift | failed). Paired with pharmax_payment_ledger_drift_total which counts individual drifted invoices by kind.",
  }
);

const paymentLedgerDriftCounter = meter.createCounter("pharmax_payment_ledger_drift_total", {
  description:
    "Invoices where the payment ledger and the invoice projection disagree, labelled by drift_kind (PAYMENT_ROWS_MISSING | PAYMENT_SUM_MISMATCH | REFUND_LEDGER_EXCEEDS_LINES | PAYMENT_ON_UNPAID_INVOICE). Alert source for PaymentLedgerDriftDetected.",
});

/**
 * Every way the ledger and the projection can disagree. Kinds are
 * stable strings — they label the drift counter and appear in the
 * structured drift logs the runbook tells operators to search for.
 */
export const PAYMENT_LEDGER_DRIFT_KINDS = [
  /** OPEN/PAID invoice with amountPaidCents > 0 and zero PAYMENT rows. */
  "PAYMENT_ROWS_MISSING",
  /** PAYMENT rows exist but their sum ≠ amountPaidCents. */
  "PAYMENT_SUM_MISMATCH",
  /** REFUND ledger sum exceeds the stripe-refund CREDIT-line total. */
  "REFUND_LEDGER_EXCEEDS_LINES",
  /** Any ledger row referencing a DRAFT/VOID/UNCOLLECTIBLE invoice. */
  "PAYMENT_ON_UNPAID_INVOICE",
] as const;

export type PaymentLedgerDriftKind = (typeof PAYMENT_LEDGER_DRIFT_KINDS)[number];

export interface PaymentLedgerDrift {
  readonly organizationId: string;
  readonly invoiceId: string;
  /** Null on the orphan check, where only the ledger row is in hand. */
  readonly invoiceNumber: string | null;
  readonly driftKind: PaymentLedgerDriftKind;
  /** What the projection says the figure should be. */
  readonly expectedCents: number;
  /** What the ledger actually sums to. */
  readonly actualCents: number;
}

/**
 * Structured tally produced by `runOnce()` and emitted as the
 * `payment_ledger_reconciliation.run.complete` log line. The nightly
 * digest and SOC 2 / audit evidence pulls read these counters from
 * the structured log; `drifts` carries the first `maxReportedDrifts`
 * individual records for the CLI-style consumer and tests.
 */
export interface PaymentLedgerReconciliationRunSummary {
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly organizationCount: number;
  /** Orgs whose every checked invoice reconciled exactly. */
  readonly orgsClean: number;
  /** Orgs with at least one drifted invoice. */
  readonly orgsWithDrift: number;
  /** Orgs whose scan threw — counted; logged; the loop continued. */
  readonly orgsFailed: number;
  readonly invoicesChecked: number;
  readonly driftCount: number;
  readonly driftByKind: Readonly<Record<string, number>>;
  /**
   * Invoices where refund CREDIT lines exceed the REFUND ledger sum —
   * the expected shape of a refund that is still pending at Stripe.
   * Informational, NOT drift; a value that never drains back to zero
   * over days is worth a look (a settle webhook may have been lost).
   */
  readonly unsettledRefundInvoices: number;
  readonly unsettledRefundCents: number;
  readonly drifts: readonly PaymentLedgerDrift[];
  /** True when driftCount exceeded maxReportedDrifts. */
  readonly driftsTruncated: boolean;
}

export interface PaymentLedgerReconciliationLoopOptions {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  /** Default 03:30 UTC — after the 01:30–03:00 UTC security jobs. */
  readonly utcHour?: number;
  readonly utcMinute?: number;
  /** PAID invoices fetched per page; default 500. */
  readonly pageSize?: number;
  /** Individual drift records carried in the summary; default 100. */
  readonly maxReportedDrifts?: number;
  /** Per-org cap on individually logged drift lines; default 20. */
  readonly logDetailLimit?: number;
  /** Override the clock; tests use a fake. */
  readonly now?: () => Date;
}

export interface PaymentLedgerReconciliationLoop {
  readonly scheduler: DailyUtcScheduler;
  start(): void;
  stop(): Promise<void>;
  /** Exposed for tests + manual on-demand invocations. */
  runOnce(at?: Date): Promise<PaymentLedgerReconciliationRunSummary>;
}

interface OrgScanResult {
  readonly invoicesChecked: number;
  readonly drifts: readonly PaymentLedgerDrift[];
  readonly unsettledRefundInvoices: number;
  readonly unsettledRefundCents: number;
}

export function createPaymentLedgerReconciliationLoop(
  options: PaymentLedgerReconciliationLoopOptions
): PaymentLedgerReconciliationLoop {
  const log = options.logger.child({ component: "payment-ledger-reconciliation" });
  const utcHour = options.utcHour ?? 3;
  const utcMinute = options.utcMinute ?? 30;
  const pageSize = options.pageSize ?? 500;
  const maxReportedDrifts = options.maxReportedDrifts ?? 100;
  const logDetailLimit = options.logDetailLimit ?? 20;
  const clock = options.now ?? (() => new Date());
  const { prisma } = options;

  let stopRequested = false;

  async function scanOrg(organizationId: string): Promise<OrgScanResult> {
    const drifts: PaymentLedgerDrift[] = [];
    let invoicesChecked = 0;
    let unsettledRefundInvoices = 0;
    let unsettledRefundCents = 0;

    // ---- Pass 1: page over money-bearing invoices (OPEN + PAID) ----
    // OPEN is in scope for partial manual payments; both statuses
    // share the same "ledger PAYMENT sum equals amountPaidCents"
    // parity contract.
    let cursor: string | null = null;
    for (;;) {
      const page: ReadonlyArray<{
        readonly id: string;
        readonly invoiceNumber: string;
        readonly amountPaidCents: number;
      }> = await prisma.invoice.findMany({
        where: {
          organizationId,
          status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PAID] },
          ...(cursor !== null ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: pageSize,
        select: { id: true, invoiceNumber: true, amountPaidCents: true },
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1]!.id;
      invoicesChecked += page.length;

      const invoiceIds = page.map((invoice) => invoice.id);

      // One ledger read + one line read per page; summed in memory.
      // Page size bounds both result sets (a few rows per invoice).
      const ledgerRows: ReadonlyArray<{
        readonly invoiceId: string;
        readonly kind: PaymentKind;
        readonly amountCents: number;
      }> = await prisma.payment.findMany({
        where: { invoiceId: { in: invoiceIds } },
        select: { invoiceId: true, kind: true, amountCents: true },
      });
      const refundLines: ReadonlyArray<{
        readonly invoiceId: string;
        readonly amountCents: number;
      }> = await prisma.invoiceLine.findMany({
        where: {
          invoiceId: { in: invoiceIds },
          kind: InvoiceLineKind.CREDIT,
          billingEventKey: { startsWith: "stripe-refund:" },
        },
        select: { invoiceId: true, amountCents: true },
      });

      const paymentSums = new Map<string, number>();
      const refundLedgerSums = new Map<string, number>();
      for (const row of ledgerRows) {
        // Ledger amounts are positive by invariant; direction is kind.
        if (row.kind === PaymentKind.PAYMENT) {
          paymentSums.set(row.invoiceId, (paymentSums.get(row.invoiceId) ?? 0) + row.amountCents);
        } else {
          refundLedgerSums.set(
            row.invoiceId,
            (refundLedgerSums.get(row.invoiceId) ?? 0) + row.amountCents
          );
        }
      }
      const refundLineSums = new Map<string, number>();
      for (const line of refundLines) {
        // CREDIT lines store negative amounts; the parity figure is |sum|.
        refundLineSums.set(
          line.invoiceId,
          (refundLineSums.get(line.invoiceId) ?? 0) + Math.abs(line.amountCents)
        );
      }

      for (const invoice of page) {
        const paidLedgerCents = paymentSums.get(invoice.id) ?? 0;
        if (invoice.amountPaidCents > 0 && paidLedgerCents === 0) {
          drifts.push({
            organizationId,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            driftKind: "PAYMENT_ROWS_MISSING",
            expectedCents: invoice.amountPaidCents,
            actualCents: 0,
          });
        } else if (paidLedgerCents !== invoice.amountPaidCents) {
          // Covers both "rows exist but sum wrong" and "projection
          // says zero paid but ledger has rows".
          drifts.push({
            organizationId,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            driftKind: "PAYMENT_SUM_MISMATCH",
            expectedCents: invoice.amountPaidCents,
            actualCents: paidLedgerCents,
          });
        }

        const refundLedgerCents = refundLedgerSums.get(invoice.id) ?? 0;
        const refundLineCents = refundLineSums.get(invoice.id) ?? 0;
        if (refundLedgerCents > refundLineCents) {
          drifts.push({
            organizationId,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            driftKind: "REFUND_LEDGER_EXCEEDS_LINES",
            expectedCents: refundLineCents,
            actualCents: refundLedgerCents,
          });
        } else if (refundLineCents > refundLedgerCents) {
          unsettledRefundInvoices += 1;
          unsettledRefundCents += refundLineCents - refundLedgerCents;
        }
      }

      if (page.length < pageSize) break;
    }

    // ---- Pass 2: orphan check — rows on non-money-bearing invoices ----
    // Every ledger writer commits its row in the same tx as a balance
    // mutation on an OPEN or PAID invoice, so a row pointing at a
    // DRAFT/VOID/UNCOLLECTIBLE invoice is out-of-band writes.
    const orphanRows: ReadonlyArray<{
      readonly invoiceId: string;
      readonly amountCents: number;
    }> = await prisma.payment.findMany({
      where: {
        organizationId,
        invoice: { status: { notIn: [InvoiceStatus.OPEN, InvoiceStatus.PAID] } },
      },
      select: { invoiceId: true, amountCents: true },
    });
    const orphanSums = new Map<string, number>();
    for (const row of orphanRows) {
      orphanSums.set(row.invoiceId, (orphanSums.get(row.invoiceId) ?? 0) + row.amountCents);
    }
    for (const [invoiceId, actualCents] of orphanSums) {
      drifts.push({
        organizationId,
        invoiceId,
        invoiceNumber: null,
        driftKind: "PAYMENT_ON_UNPAID_INVOICE",
        expectedCents: 0,
        actualCents,
      });
    }

    return { invoicesChecked, drifts, unsettledRefundInvoices, unsettledRefundCents };
  }

  async function runOnce(at?: Date): Promise<PaymentLedgerReconciliationRunSummary> {
    const startedAt = at ?? clock();
    const orgs = await withSystemContext("billing:list-orgs-for-payment-reconciliation", () =>
      prisma.organization.findMany({
        select: { id: true, slug: true },
        orderBy: { slug: "asc" },
      })
    );
    log.info("payment_ledger_reconciliation.run.start", {
      organizationCount: orgs.length,
      startedAt: startedAt.toISOString(),
    });

    let orgsClean = 0;
    let orgsWithDrift = 0;
    let orgsFailed = 0;
    let invoicesChecked = 0;
    let unsettledRefundInvoices = 0;
    let unsettledRefundCents = 0;
    const driftByKind: Record<string, number> = {};
    const reportedDrifts: PaymentLedgerDrift[] = [];
    let driftCount = 0;

    for (const org of orgs) {
      if (stopRequested) {
        log.warn("payment_ledger_reconciliation.run.stop_requested_mid_batch", {
          remaining: orgs.length - (orgsClean + orgsWithDrift + orgsFailed),
        });
        break;
      }
      try {
        const result = await withSystemContext("billing:reconcile-payment-ledger", () =>
          scanOrg(org.id)
        );
        invoicesChecked += result.invoicesChecked;
        unsettledRefundInvoices += result.unsettledRefundInvoices;
        unsettledRefundCents += result.unsettledRefundCents;

        if (result.drifts.length === 0) {
          orgsClean += 1;
          reconciliationRunsCounter.add(1, { organization_id: org.id, outcome: "clean" });
          log.info("payment_ledger_reconciliation.run.org.clean", {
            organizationId: org.id,
            slug: org.slug,
            invoicesChecked: result.invoicesChecked,
            unsettledRefundInvoices: result.unsettledRefundInvoices,
            unsettledRefundCents: result.unsettledRefundCents,
          });
        } else {
          orgsWithDrift += 1;
          reconciliationRunsCounter.add(1, { organization_id: org.id, outcome: "drift" });
          driftCount += result.drifts.length;

          for (const drift of result.drifts) {
            driftByKind[drift.driftKind] = (driftByKind[drift.driftKind] ?? 0) + 1;
            paymentLedgerDriftCounter.add(1, {
              organization_id: org.id,
              drift_kind: drift.driftKind,
            });
            if (reportedDrifts.length < maxReportedDrifts) {
              reportedDrifts.push(drift);
            }
          }

          // Log the first N drifted invoices individually (grep-able
          // remediation starting points); above the cap, the org-level
          // error line still carries the full counts so nothing is
          // silently dropped — the detail just moves to a manual query.
          for (const drift of result.drifts.slice(0, logDetailLimit)) {
            log.error("payment_ledger_reconciliation.drift", {
              organizationId: org.id,
              slug: org.slug,
              invoiceId: drift.invoiceId,
              invoiceNumber: drift.invoiceNumber,
              driftKind: drift.driftKind,
              expectedCents: drift.expectedCents,
              actualCents: drift.actualCents,
            });
          }
          log.error("payment_ledger_reconciliation.run.org.drift", {
            organizationId: org.id,
            slug: org.slug,
            invoicesChecked: result.invoicesChecked,
            driftCount: result.drifts.length,
            driftDetailLogged: Math.min(result.drifts.length, logDetailLimit),
          });
        }
      } catch (cause) {
        orgsFailed += 1;
        reconciliationRunsCounter.add(1, { organization_id: org.id, outcome: "failed" });
        const message =
          cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
        log.error("payment_ledger_reconciliation.run.org.failed", {
          organizationId: org.id,
          slug: org.slug,
          errorMessage: message,
        });
      }
    }

    const summary: PaymentLedgerReconciliationRunSummary = {
      startedAt,
      completedAt: clock(),
      organizationCount: orgs.length,
      orgsClean,
      orgsWithDrift,
      orgsFailed,
      invoicesChecked,
      driftCount,
      driftByKind: Object.freeze({ ...driftByKind }),
      unsettledRefundInvoices,
      unsettledRefundCents,
      drifts: reportedDrifts,
      driftsTruncated: driftCount > reportedDrifts.length,
    };

    log.info("payment_ledger_reconciliation.run.complete", {
      startedAt: summary.startedAt.toISOString(),
      completedAt: summary.completedAt.toISOString(),
      organizationCount: summary.organizationCount,
      orgsClean: summary.orgsClean,
      orgsWithDrift: summary.orgsWithDrift,
      orgsFailed: summary.orgsFailed,
      invoicesChecked: summary.invoicesChecked,
      driftCount: summary.driftCount,
      driftByKind: summary.driftByKind,
      unsettledRefundInvoices: summary.unsettledRefundInvoices,
      unsettledRefundCents: summary.unsettledRefundCents,
      driftsTruncated: summary.driftsTruncated,
    });

    return summary;
  }

  const scheduler = createDailyUtcScheduler({
    name: "payment-ledger-reconciliation",
    utcHour,
    utcMinute,
    runJob: async () => {
      await runOnce();
    },
    logger: options.logger,
  });

  return {
    scheduler,
    start(): void {
      scheduler.start();
    },
    async stop(): Promise<void> {
      stopRequested = true;
      await scheduler.stop();
    },
    runOnce,
  };
}
