// AutoFinalizeDueInvoice — the period-boundary cron's finalize path.
//
// Pipeline:
//
//   invoice-auto-finalize-loop (apps/worker, daily)
//     → scans each org for DRAFT invoices whose billing period ended
//     → dispatches AutoFinalizeDueInvoice (this system command) for
//       each one that carries a FRESH approval
//     → DRAFT → OPEN via the SAME core as the operator's
//       FinalizeInvoice (billing.invoice.finalized.v1 → Stripe push)
//
// Why a SystemCommand:
//   - The dispatch is machine-driven (a scheduler tick), not a human
//     action. The human judgment already happened — it is the
//     APPROVAL, recorded by ApproveInvoice with the reviewer's user
//     stamp. This command only executes the mechanical consequence
//     of that decision once the billing period closes.
//   - The SystemCommand contract still gives the full write ritual:
//     command_log, audit row (carrying `targetOrganizationId`), and
//     the outbox event, all in one tx.
//
// THE LOAD-BEARING GUARD — approval, exactly as the tenant command:
//   - `assertReadyToFinalize` (shared core) requires `approvedAt` set
//     AND `approvedVersion === version`. The cron NEVER finalizes an
//     unreviewed or stale-reviewed draft; those are surfaced by the
//     loop as an awaiting-review backlog, not forced through.
//   - On top of the shared guards, this command adds the
//     period-boundary guard: `billingPeriodEnd` must exist and be in
//     the past. An operator can finalize mid-period deliberately
//     (early close-out); the MACHINE only acts once the period is
//     unambiguously over. Invoices with no `billingPeriodEnd` (none
//     are produced today — the materializer always stamps one) are
//     refused rather than guessed at.
//
// Idempotency / races:
//   - Non-DRAFT status short-circuits as `alreadyFinalized: true`
//     (the operator may have clicked Finalize between the loop's
//     scan and this dispatch) — no mutation, no outbox emit.
//   - The core's CAS on `version` catches every other race (a line
//     appended between scan and dispatch bumps the version, so the
//     approval-staleness check re-runs against fresh row state
//     inside this tx, and the CAS backstops the rest).
//
// PHI invariant: no PHI is read or written — invoice ids, numbers,
// cents, timestamps.

import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { InvoiceStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { getMeter } from "@pharmax/telemetry";
import { z } from "zod";

import {
  assertReadyToFinalize,
  invoiceFinalizedOutboxEvent,
  loadInvoiceForFinalize,
  performFinalizeCas,
  type FinalizableInvoice,
} from "../finalize-invoice-core.js";

const meter = getMeter("@pharmax/billing");

const billingInvoiceAutoFinalizedCounter = meter.createCounter(
  "pharmax_billing_invoice_auto_finalized_total",
  {
    description:
      "Invoices transitioned DRAFT → OPEN by the period-boundary cron (AutoFinalizeDueInvoice). Operator finalizations count under pharmax_billing_invoice_finalized_total instead; races resolved as already-finalized are NOT counted.",
  }
);

export const AUTO_FINALIZE_INVOICE_NOT_FOUND = "AUTO_FINALIZE_INVOICE_NOT_FOUND";
export const AUTO_FINALIZE_PERIOD_NOT_ENDED = "AUTO_FINALIZE_PERIOD_NOT_ENDED";
export const AUTO_FINALIZE_NO_BILLING_PERIOD = "AUTO_FINALIZE_NO_BILLING_PERIOD";

const inputSchema = z
  .object({
    organizationId: z.uuid(),
    invoiceId: z.uuid(),
    /** Same v1 default as the operator path. */
    daysUntilDue: z.number().int().min(0).max(365).default(30),
  })
  .strict();

export type AutoFinalizeDueInvoiceInput = z.infer<typeof inputSchema>;

export interface AutoFinalizeDueInvoiceOutput {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly status: InvoiceStatus;
  readonly issuedAt: string;
  readonly dueAt: string;
  readonly totalCents: number;
  readonly lineCount: number;
  readonly version: number;
  /** `true` when the invoice was already non-DRAFT — no mutation occurred. */
  readonly alreadyFinalized: boolean;
}

function assertPeriodEnded(invoice: FinalizableInvoice, now: Date): void {
  if (invoice.billingPeriodEnd === null) {
    throw new errors.ConflictError({
      code: AUTO_FINALIZE_NO_BILLING_PERIOD,
      message:
        "Invoice has no billingPeriodEnd — the cron only finalizes period-bounded invoices. Finalize manually if intended.",
      metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
    });
  }
  if (invoice.billingPeriodEnd.getTime() >= now.getTime()) {
    throw new errors.ConflictError({
      code: AUTO_FINALIZE_PERIOD_NOT_ENDED,
      message: "Invoice billing period has not ended yet — nothing to auto-finalize.",
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        billingPeriodEnd: invoice.billingPeriodEnd.toISOString(),
        now: now.toISOString(),
      },
    });
  }
}

export const AutoFinalizeDueInvoice: SystemCommand<
  AutoFinalizeDueInvoiceInput,
  AutoFinalizeDueInvoiceOutput
> = {
  name: "AutoFinalizeDueInvoice",
  inputSchema,

  async handle({
    input,
    tx,
    clock,
    commandLogId,
  }): Promise<SystemHandlerResult<AutoFinalizeDueInvoiceOutput>> {
    const invoice = await loadInvoiceForFinalize(tx, {
      invoiceId: input.invoiceId,
      organizationId: input.organizationId,
    });
    if (invoice === null) {
      throw new errors.NotFoundError({
        code: AUTO_FINALIZE_INVOICE_NOT_FOUND,
        message: "Invoice not found in the target organization.",
        metadata: { organizationId: input.organizationId, invoiceId: input.invoiceId },
      });
    }

    const now = clock.now();

    // ---- Already-finalized short-circuit ----
    // The operator may have finalized between the loop's scan and
    // this dispatch; that is success, not an error.
    if (invoice.status !== InvoiceStatus.DRAFT) {
      return {
        output: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          issuedAt: (invoice.issuedAt ?? now).toISOString(),
          dueAt: (invoice.dueAt ?? now).toISOString(),
          totalCents: invoice.totalCents,
          lineCount: invoice.lineCount,
          version: invoice.version,
          alreadyFinalized: true,
        },
        targetOrganizationId: input.organizationId,
        audit: {
          action: "billing.invoice.auto_finalize.skipped",
          resourceType: "Invoice",
          resourceId: invoice.id,
          metadata: {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            currentStatus: invoice.status,
            reason: "already-finalized",
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: [],
      };
    }

    // ---- Machine-only guard, then the shared gate + CAS ----
    assertPeriodEnded(invoice, now);
    assertReadyToFinalize(invoice);

    const cas = await performFinalizeCas(tx, {
      invoice,
      daysUntilDue: input.daysUntilDue,
      now,
    });

    billingInvoiceAutoFinalizedCounter.add(1, { organization_id: input.organizationId });

    return {
      output: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: InvoiceStatus.OPEN,
        issuedAt: cas.issuedAt.toISOString(),
        dueAt: cas.dueAt.toISOString(),
        totalCents: invoice.totalCents,
        lineCount: invoice.lineCount,
        version: cas.nextVersion,
        alreadyFinalized: false,
      },
      targetOrganizationId: input.organizationId,
      audit: {
        action: "billing.invoice.auto_finalized",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          previousStatus: InvoiceStatus.DRAFT,
          newStatus: InvoiceStatus.OPEN,
          trigger: "period-boundary-cron",
          billingPeriodEnd: invoice.billingPeriodEnd?.toISOString() ?? null,
          subtotalCents: invoice.subtotalCents,
          totalCents: invoice.totalCents,
          lineCount: invoice.lineCount,
          daysUntilDue: input.daysUntilDue,
          issuedAt: cas.issuedAt.toISOString(),
          dueAt: cas.dueAt.toISOString(),
          // The approval this finalization consumed — the human
          // decision the machine is executing.
          approvedByUserId: invoice.approvedByUserId,
          approvedVersion: invoice.approvedVersion,
          approvedAt: invoice.approvedAt?.toISOString() ?? null,
          commandLogId,
        },
      },
      outboxEvents: [
        invoiceFinalizedOutboxEvent({
          organizationId: input.organizationId,
          invoice,
          cas,
          occurredAt: now,
        }),
      ],
    };
  },
};
