// Daily period-boundary invoice auto-finalize loop (flagship billing).
//
// WHAT IT DOES — once a day, per organization: find DRAFT invoices
// whose billing period has ENDED, and
//
//   - dispatch `AutoFinalizeDueInvoice` for each one carrying a
//     FRESH approval (`approvedAt` set, `approvedVersion === version`)
//     — DRAFT → OPEN through the same core + guards as the operator's
//     FinalizeInvoice, emitting the same `billing.invoice.finalized.v1`
//     event so the Stripe push follows automatically;
//   - SURFACE, never force, everything else:
//       awaiting_review  — never approved. The reviewer signal: these
//                          are period-closed invoices stuck behind a
//                          missing human review.
//       stale_approval   — approved, but lines landed after the
//                          review (version moved). Needs re-approval.
//       empty_draft      — zero lines; nothing to bill. Left alone.
//
// The division of judgment is deliberate: the HUMAN decision is the
// approval (recorded with a user stamp by ApproveInvoice); the cron
// only executes the mechanical consequence of that decision once the
// period closes. An org that wants fully-manual finalization simply
// disables the loop (`BILLING_AUTO_FINALIZE_ENABLED=false`) — the
// operator flow is unchanged either way.
//
// RACES — the scan is a snapshot, so every dispatch re-validates
// inside its own command tx: operator finalized in between →
// `alreadyFinalized` short-circuit (success); line appended in
// between → the approval-staleness guard re-fires against fresh row
// state and the invoice is skipped this run (typed ConflictError,
// tallied as a dispatch failure with its code; tomorrow's run picks
// it up after re-approval).
//
// SCHEDULING — 04:10 UTC by default, after the payment-ledger
// reconciliation (03:30) so the nightly billing scans don't stack,
// and so reconciliation always sees yesterday's finalizations settled.
//
// PER-ORG ISOLATION — one org's failure must not stop the loop from
// processing the next org (mirrors the reconciliation verifier).
//
// PHI: none anywhere in this file — invoice ids, invoice numbers,
// cents, counts, timestamps.

import { AutoFinalizeDueInvoice, type AutoFinalizeDueInvoiceOutput } from "@pharmax/billing";
import { executeSystemCommand } from "@pharmax/command-bus";
import { InvoiceStatus, type PrismaClient } from "@pharmax/database";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { getMeter } from "@pharmax/telemetry";
import { withSystemContext } from "@pharmax/tenancy";

import {
  createDailyUtcScheduler,
  type DailyUtcScheduler,
} from "../security/daily-utc-scheduler.js";

type Logger = loggerContract.Logger;

const meter = getMeter("@pharmax/worker.billing");

const autoFinalizeRunsCounter = meter.createCounter("pharmax_billing_auto_finalize_runs_total", {
  description:
    "Daily invoice auto-finalize completions, labelled by per-org outcome (ok | failed). Individual finalizations count under pharmax_billing_invoice_auto_finalized_total (emitted by the command).",
});

const autoFinalizeSkipsCounter = meter.createCounter("pharmax_billing_auto_finalize_skips_total", {
  description:
    "Period-ended DRAFT invoices the auto-finalize loop deliberately left alone, labelled by reason (awaiting_review | stale_approval | empty_draft). A growing awaiting_review count means reviews are the billing bottleneck.",
});

const autoFinalizeDispatchFailuresCounter = meter.createCounter(
  "pharmax_billing_auto_finalize_dispatch_failures_total",
  {
    description:
      "AutoFinalizeDueInvoice dispatches that threw (races re-validated inside the command tx, transient DB errors). The invoice is retried on the next daily run.",
  }
);

/** Why a period-ended DRAFT invoice was not dispatched. */
export const AUTO_FINALIZE_SKIP_REASONS = [
  "awaiting_review",
  "stale_approval",
  "empty_draft",
] as const;

export type AutoFinalizeSkipReason = (typeof AUTO_FINALIZE_SKIP_REASONS)[number];

export interface InvoiceAutoFinalizeRunSummary {
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly organizationCount: number;
  /** Orgs fully processed (even if some dispatches failed). */
  readonly orgsProcessed: number;
  /** Orgs whose scan threw — counted; logged; the loop continued. */
  readonly orgsFailed: number;
  /** Period-ended DRAFT invoices seen across all orgs. */
  readonly invoicesScanned: number;
  /** Successfully transitioned DRAFT → OPEN this run. */
  readonly invoicesFinalized: number;
  /** Dispatched, but the command short-circuited (operator raced us). */
  readonly invoicesAlreadyFinalized: number;
  /** Dispatches that threw; retried on the next run. */
  readonly invoicesFailed: number;
  readonly skippedByReason: Readonly<Record<AutoFinalizeSkipReason, number>>;
}

/**
 * Injectable dispatch seam — tests supply a fake; production wiring
 * uses the real system-command bus (the default).
 */
export type AutoFinalizeDispatch = (input: {
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly daysUntilDue: number;
}) => Promise<AutoFinalizeDueInvoiceOutput>;

const defaultDispatch: AutoFinalizeDispatch = async (input) =>
  executeSystemCommand(AutoFinalizeDueInvoice, input);

export interface InvoiceAutoFinalizeLoopOptions {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  /** Default 04:10 UTC — after the payment-ledger reconciler (03:30). */
  readonly utcHour?: number;
  readonly utcMinute?: number;
  /** DRAFT invoices fetched per page; default 200. */
  readonly pageSize?: number;
  /** Payment terms stamped on auto-finalized invoices; default 30. */
  readonly daysUntilDue?: number;
  readonly dispatchAutoFinalize?: AutoFinalizeDispatch;
  /** Override the clock; tests use a fake. */
  readonly now?: () => Date;
}

export interface InvoiceAutoFinalizeLoop {
  readonly scheduler: DailyUtcScheduler;
  start(): void;
  stop(): Promise<void>;
  /** Exposed for tests + manual on-demand invocations. */
  runOnce(at?: Date): Promise<InvoiceAutoFinalizeRunSummary>;
}

interface ScannedInvoice {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly approvedAt: Date | null;
  readonly approvedVersion: number | null;
  readonly version: number;
  readonly _count: { readonly lines: number };
}

export function createInvoiceAutoFinalizeLoop(
  options: InvoiceAutoFinalizeLoopOptions
): InvoiceAutoFinalizeLoop {
  const log = options.logger.child({ component: "invoice-auto-finalize" });
  const utcHour = options.utcHour ?? 4;
  const utcMinute = options.utcMinute ?? 10;
  const pageSize = options.pageSize ?? 200;
  const daysUntilDue = options.daysUntilDue ?? 30;
  const dispatch = options.dispatchAutoFinalize ?? defaultDispatch;
  const clock = options.now ?? (() => new Date());
  const { prisma } = options;

  let stopRequested = false;

  function classify(invoice: ScannedInvoice): AutoFinalizeSkipReason | null {
    if (invoice._count.lines === 0) return "empty_draft";
    if (invoice.approvedAt === null) return "awaiting_review";
    if (invoice.approvedVersion !== invoice.version) return "stale_approval";
    return null;
  }

  interface OrgResult {
    readonly invoicesScanned: number;
    readonly invoicesFinalized: number;
    readonly invoicesAlreadyFinalized: number;
    readonly invoicesFailed: number;
    readonly skippedByReason: Record<AutoFinalizeSkipReason, number>;
  }

  async function processOrg(org: { id: string; slug: string }, cutoff: Date): Promise<OrgResult> {
    let invoicesScanned = 0;
    let invoicesFinalized = 0;
    let invoicesAlreadyFinalized = 0;
    let invoicesFailed = 0;
    const skippedByReason: Record<AutoFinalizeSkipReason, number> = {
      awaiting_review: 0,
      stale_approval: 0,
      empty_draft: 0,
    };

    let cursor: string | null = null;
    for (;;) {
      const page: ReadonlyArray<ScannedInvoice> = await withSystemContext(
        "billing:auto-finalize-scan",
        () =>
          prisma.invoice.findMany({
            where: {
              organizationId: org.id,
              status: InvoiceStatus.DRAFT,
              billingPeriodEnd: { lt: cutoff },
              ...(cursor !== null ? { id: { gt: cursor } } : {}),
            },
            orderBy: { id: "asc" },
            take: pageSize,
            select: {
              id: true,
              invoiceNumber: true,
              approvedAt: true,
              approvedVersion: true,
              version: true,
              _count: { select: { lines: true } },
            },
          })
      );
      if (page.length === 0) break;
      cursor = page[page.length - 1]!.id;
      invoicesScanned += page.length;

      for (const invoice of page) {
        const skipReason = classify(invoice);
        if (skipReason !== null) {
          skippedByReason[skipReason] += 1;
          autoFinalizeSkipsCounter.add(1, { organization_id: org.id, reason: skipReason });
          continue;
        }

        try {
          const result = await withSystemContext("billing:auto-finalize-dispatch", () =>
            dispatch({ organizationId: org.id, invoiceId: invoice.id, daysUntilDue })
          );
          if (result.alreadyFinalized) {
            invoicesAlreadyFinalized += 1;
          } else {
            invoicesFinalized += 1;
            log.info("invoice_auto_finalize.finalized", {
              organizationId: org.id,
              slug: org.slug,
              invoiceId: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
              totalCents: result.totalCents,
              lineCount: result.lineCount,
              dueAt: result.dueAt,
            });
          }
        } catch (cause) {
          invoicesFailed += 1;
          autoFinalizeDispatchFailuresCounter.add(1, { organization_id: org.id });
          const code =
            cause !== null && typeof cause === "object" && "code" in cause
              ? String((cause as { code: unknown }).code)
              : null;
          const message =
            cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
          log.error("invoice_auto_finalize.dispatch_failed", {
            organizationId: org.id,
            slug: org.slug,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            errorCode: code,
            errorMessage: message,
          });
        }
      }

      if (page.length < pageSize) break;
    }

    return {
      invoicesScanned,
      invoicesFinalized,
      invoicesAlreadyFinalized,
      invoicesFailed,
      skippedByReason,
    };
  }

  async function runOnce(at?: Date): Promise<InvoiceAutoFinalizeRunSummary> {
    const startedAt = at ?? clock();
    const orgs = await withSystemContext("billing:list-orgs-for-auto-finalize", () =>
      prisma.organization.findMany({
        select: { id: true, slug: true },
        orderBy: { slug: "asc" },
      })
    );
    log.info("invoice_auto_finalize.run.start", {
      organizationCount: orgs.length,
      startedAt: startedAt.toISOString(),
    });

    let orgsProcessed = 0;
    let orgsFailed = 0;
    let invoicesScanned = 0;
    let invoicesFinalized = 0;
    let invoicesAlreadyFinalized = 0;
    let invoicesFailed = 0;
    const skippedByReason: Record<AutoFinalizeSkipReason, number> = {
      awaiting_review: 0,
      stale_approval: 0,
      empty_draft: 0,
    };

    for (const org of orgs) {
      if (stopRequested) {
        log.warn("invoice_auto_finalize.run.stop_requested_mid_batch", {
          remaining: orgs.length - (orgsProcessed + orgsFailed),
        });
        break;
      }
      try {
        const result = await processOrg(org, startedAt);
        orgsProcessed += 1;
        autoFinalizeRunsCounter.add(1, { organization_id: org.id, outcome: "ok" });
        invoicesScanned += result.invoicesScanned;
        invoicesFinalized += result.invoicesFinalized;
        invoicesAlreadyFinalized += result.invoicesAlreadyFinalized;
        invoicesFailed += result.invoicesFailed;
        for (const reason of AUTO_FINALIZE_SKIP_REASONS) {
          skippedByReason[reason] += result.skippedByReason[reason];
        }

        // The awaiting-review backlog is the ops signal this loop
        // exists to make visible — a period has CLOSED and money is
        // sitting unbilled behind a missing human review.
        if (result.skippedByReason.awaiting_review > 0) {
          log.warn("invoice_auto_finalize.awaiting_review_backlog", {
            organizationId: org.id,
            slug: org.slug,
            awaitingReview: result.skippedByReason.awaiting_review,
            staleApproval: result.skippedByReason.stale_approval,
          });
        }
        log.info("invoice_auto_finalize.run.org.complete", {
          organizationId: org.id,
          slug: org.slug,
          invoicesScanned: result.invoicesScanned,
          invoicesFinalized: result.invoicesFinalized,
          invoicesAlreadyFinalized: result.invoicesAlreadyFinalized,
          invoicesFailed: result.invoicesFailed,
          skippedByReason: result.skippedByReason,
        });
      } catch (cause) {
        orgsFailed += 1;
        autoFinalizeRunsCounter.add(1, { organization_id: org.id, outcome: "failed" });
        const message =
          cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
        log.error("invoice_auto_finalize.run.org.failed", {
          organizationId: org.id,
          slug: org.slug,
          errorMessage: message,
        });
      }
    }

    const summary: InvoiceAutoFinalizeRunSummary = {
      startedAt,
      completedAt: clock(),
      organizationCount: orgs.length,
      orgsProcessed,
      orgsFailed,
      invoicesScanned,
      invoicesFinalized,
      invoicesAlreadyFinalized,
      invoicesFailed,
      skippedByReason: Object.freeze({ ...skippedByReason }),
    };

    log.info("invoice_auto_finalize.run.complete", {
      startedAt: summary.startedAt.toISOString(),
      completedAt: summary.completedAt.toISOString(),
      organizationCount: summary.organizationCount,
      orgsProcessed: summary.orgsProcessed,
      orgsFailed: summary.orgsFailed,
      invoicesScanned: summary.invoicesScanned,
      invoicesFinalized: summary.invoicesFinalized,
      invoicesAlreadyFinalized: summary.invoicesAlreadyFinalized,
      invoicesFailed: summary.invoicesFailed,
      skippedByReason: summary.skippedByReason,
    });

    return summary;
  }

  const scheduler = createDailyUtcScheduler({
    name: "invoice-auto-finalize",
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
