// ApproveInvoice — the human review gate between DRAFT and OPEN.
//
// Lifecycle:
//
//   DRAFT (accepts new lines)
//     → ApproveInvoice   (this command — records the review)
//   DRAFT + approval stamp
//     → FinalizeInvoice  (requires a FRESH approval; DRAFT → OPEN)
//   OPEN  (no new lines; awaiting Stripe push + collection)
//
// Why a separate command (vs. folding review into FinalizeInvoice):
//
//   - Segregation of duties. `billing.approve_invoice` and
//     `billing.finalize_invoice` are distinct permissions, so an org
//     can require the reviewer and the finalizer to be different
//     roles (or the same BillingManager in a small shop — both are on
//     the template). Structural same-user SoD enforcement (the
//     `SOD_RULES` registry) is order-event-scoped today; extending it
//     to invoice events is a future slice, and the permission split
//     is the load-bearing control until then.
//   - An approval is EVIDENCE ("who signed off, on which revision"),
//     not a state transition — the invoice stays DRAFT, and the
//     materializer may still append late shipped-order lines.
//
// Freshness — the version anchor:
//
//   - The approval stamps `approvedVersion` with the invoice `version`
//     AS OF the approval commit (this command's own CAS bump, so
//     post-commit `approvedVersion === version`).
//   - Every line append bumps `version` (the materializer's atomic
//     increment), so a late line landing after the review silently
//     BREAKS the equality — FinalizeInvoice rejects with
//     `FINALIZE_INVOICE_APPROVAL_STALE` and the operator re-reviews.
//     No cron, no timestamp comparison, no race window: the same CAS
//     that orders the writes orders the staleness.
//   - Re-approval of a stale stamp is just running this command again;
//     the stamp (and outbox event) refresh to the new revision.
//
// Idempotency:
//
//   - The bus's idempotency cache short-circuits a re-dispatch.
//   - A repeated approval of an UNCHANGED revision short-circuits at
//     the DB layer (`alreadyApproved: true`) — no version bump, no
//     outbox emit, tiny audit row for the timeline.
//   - The CAS on `version` makes concurrent approve calls (or an
//     approve racing a materializer append) safe: the loser sees
//     count=0 and surfaces a typed conflict.
//
// PHI invariant: no PHI is read or written. The optional
// `approvalNote` is redacted from the command log and only a
// `hasApprovalNote` boolean reaches audit metadata / outbox.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { InvoiceStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { getMeter } from "@pharmax/telemetry";
import { z } from "zod";

const meter = getMeter("@pharmax/billing");

const billingInvoiceApprovedCounter = meter.createCounter(
  "pharmax_billing_invoice_approved_total",
  {
    description:
      "DRAFT invoices approved via ApproveInvoice. Idempotent re-approvals of an unchanged revision (alreadyApproved=true) are NOT counted; re-approvals after staleness ARE.",
  }
);

export const APPROVE_INVOICE_NOT_FOUND = "APPROVE_INVOICE_NOT_FOUND";
export const APPROVE_INVOICE_INVALID_STATUS = "APPROVE_INVOICE_INVALID_STATUS";
export const APPROVE_INVOICE_EMPTY = "APPROVE_INVOICE_EMPTY";
export const APPROVE_INVOICE_VERSION_MISMATCH = "APPROVE_INVOICE_VERSION_MISMATCH";

const inputSchema = z
  .object({
    invoiceId: z.uuid(),
    /**
     * Optional reviewer note ("checked May totals against the clinic
     * contract"). Redacted from the command log; only its presence
     * (`hasApprovalNote`) reaches audit metadata.
     */
    approvalNote: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type ApproveInvoiceInput = z.infer<typeof inputSchema>;

export interface ApproveInvoiceOutput {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly status: InvoiceStatus;
  readonly totalCents: number;
  readonly lineCount: number;
  readonly approvedAt: string;
  readonly approvedByUserId: string;
  /** Invoice `version` the approval is anchored to (post-CAS). */
  readonly approvedVersion: number;
  readonly version: number;
  /** `true` when the current revision was already approved — no mutation occurred. */
  readonly alreadyApproved: boolean;
}

export const ApproveInvoice: Command<ApproveInvoiceInput, ApproveInvoiceOutput> = {
  name: "ApproveInvoice",
  inputSchema,
  permission: PERMISSIONS.BILLING_APPROVE_INVOICE,
  redactFields: ["approvalNote"],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<ApproveInvoiceOutput>> {
    // ---- Load the invoice scoped to this tenancy ----
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, organizationId: ctx.organizationId },
      select: {
        id: true,
        clinicId: true,
        invoiceNumber: true,
        status: true,
        currency: true,
        subtotalCents: true,
        totalCents: true,
        amountDueCents: true,
        approvedAt: true,
        approvedByUserId: true,
        approvedVersion: true,
        version: true,
        _count: { select: { lines: true } },
      },
    });
    if (invoice === null) {
      throw new errors.NotFoundError({
        code: APPROVE_INVOICE_NOT_FOUND,
        message: "Invoice not found in this organization.",
        metadata: { invoiceId: input.invoiceId },
      });
    }

    // ---- Status guard: only DRAFT invoices are reviewable ----
    // Approval exists to gate finalization; a non-DRAFT invoice is
    // already past the gate (or terminally out of it).
    switch (invoice.status) {
      case InvoiceStatus.DRAFT:
        break;
      case InvoiceStatus.OPEN:
      case InvoiceStatus.PAID:
        throw new errors.ConflictError({
          code: APPROVE_INVOICE_INVALID_STATUS,
          message: "Invoice is already finalized — approval only applies to DRAFT invoices.",
          metadata: { invoiceId: invoice.id, status: invoice.status },
        });
      case InvoiceStatus.VOID:
        throw new errors.ConflictError({
          code: APPROVE_INVOICE_INVALID_STATUS,
          message: "Invoice is VOID — nothing to approve.",
          metadata: { invoiceId: invoice.id, status: invoice.status },
        });
      case InvoiceStatus.UNCOLLECTIBLE:
        throw new errors.ConflictError({
          code: APPROVE_INVOICE_INVALID_STATUS,
          message: "Invoice was written off as UNCOLLECTIBLE — nothing to approve.",
          metadata: { invoiceId: invoice.id, status: invoice.status },
        });
      default: {
        const _never: never = invoice.status;
        throw new Error(`unhandled InvoiceStatus: ${String(_never)}`);
      }
    }

    // ---- Empty-invoice guard ----
    // Mirrors FinalizeInvoice: reviewing a zero-line draft is a UX
    // bug, and approving it would let finalize's own guard be the
    // first to complain — fail at the earlier gate instead.
    if (invoice._count.lines === 0) {
      throw new errors.ValidationError({
        code: APPROVE_INVOICE_EMPTY,
        message: "Cannot approve an invoice with zero lines.",
        metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
      });
    }

    const now = clock.now();
    const hasApprovalNote =
      typeof input.approvalNote === "string" && input.approvalNote.trim().length > 0;

    // ---- Already-approved short-circuit (unchanged revision) ----
    // `approvedVersion === version` means no line has landed since
    // the review — the stamp is still fresh, so a repeated click is
    // a no-op. A STALE stamp (versions differ) falls through to a
    // full re-approval below.
    if (invoice.approvedAt !== null && invoice.approvedVersion === invoice.version) {
      return {
        output: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          totalCents: invoice.totalCents,
          lineCount: invoice._count.lines,
          approvedAt: invoice.approvedAt.toISOString(),
          approvedByUserId: invoice.approvedByUserId ?? ctx.actor.userId,
          approvedVersion: invoice.approvedVersion,
          version: invoice.version,
          alreadyApproved: true,
        },
        audit: {
          action: "billing.invoice.approve.skipped",
          resourceType: "Invoice",
          resourceId: invoice.id,
          metadata: {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            reason: "already-approved",
            approvedVersion: invoice.approvedVersion,
            approvedByUserId: invoice.approvedByUserId,
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: [],
      };
    }

    const nextVersion = invoice.version + 1;

    // ---- CAS update ----
    // The version bump does double duty: it surfaces concurrent
    // writers (another approve, a materializer append) as a typed
    // conflict, AND it makes `approvedVersion = nextVersion` hold
    // exactly `approvedVersion === version` at commit time — the
    // equality FinalizeInvoice checks.
    const updated = await tx.invoice.updateMany({
      where: { id: invoice.id, version: invoice.version },
      data: {
        approvedAt: now,
        approvedByUserId: ctx.actor.userId,
        approvedVersion: nextVersion,
        version: nextVersion,
      },
    });
    if (updated.count !== 1) {
      throw new errors.ConflictError({
        code: APPROVE_INVOICE_VERSION_MISMATCH,
        message:
          "Invoice version was bumped by a concurrent mutation. Refresh the invoice and re-review.",
        metadata: { invoiceId: invoice.id, attemptedVersion: invoice.version },
      });
    }

    billingInvoiceApprovedCounter.add(1);

    const wasStaleReapproval = invoice.approvedAt !== null;

    return {
      output: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        totalCents: invoice.totalCents,
        lineCount: invoice._count.lines,
        approvedAt: now.toISOString(),
        approvedByUserId: ctx.actor.userId,
        approvedVersion: nextVersion,
        version: nextVersion,
        alreadyApproved: false,
      },
      audit: {
        action: "billing.invoice.approved",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          subtotalCents: invoice.subtotalCents,
          totalCents: invoice.totalCents,
          amountDueCents: invoice.amountDueCents,
          lineCount: invoice._count.lines,
          approvedVersion: nextVersion,
          approvedByUserId: ctx.actor.userId,
          // A re-approval after staleness records what it superseded
          // so the audit trail shows the review history in one row.
          supersededApproval: wasStaleReapproval
            ? {
                approvedAt: invoice.approvedAt?.toISOString() ?? null,
                approvedByUserId: invoice.approvedByUserId,
                approvedVersion: invoice.approvedVersion,
              }
            : null,
          hasApprovalNote,
          commandLogId,
          occurredAt: now.toISOString(),
        },
      },
      outboxEvents: [
        {
          eventType: "billing.invoice.approved.v1",
          aggregateType: "Invoice",
          aggregateId: invoice.id,
          payload: {
            organizationId: ctx.organizationId,
            clinicId: invoice.clinicId,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            currency: invoice.currency,
            subtotalCents: invoice.subtotalCents,
            totalCents: invoice.totalCents,
            amountDueCents: invoice.amountDueCents,
            lineCount: invoice._count.lines,
            approvedByUserId: ctx.actor.userId,
            approvedVersion: nextVersion,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
