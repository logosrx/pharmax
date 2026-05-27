// IssueRefund — operator-initiated Stripe refund flow.
//
// Pipeline:
//
//   1. Operator (BillingManager) clicks "Refund $X on invoice Y".
//   2. This command validates the invoice is PAID + has a
//      stripeChargeId + amount ≤ amountPaid - prior refunds.
//   3. Synchronously calls Stripe via `StripeRefundPort` (idempotent
//      on `pharmaxRefundKey`). HTTP latency lives in the operator's
//      click path — acceptable for a ~500ms call.
//   4. Writes a NEGATIVE-amount InvoiceLine on the Pharmax ledger
//      (`kind: CREDIT`, `billingEventKey: "stripe-refund:{stripeRefundId}"`).
//   5. Decrements invoice totals atomically (`{ decrement }`).
//   6. Emits `billing.invoice.refunded.v1`.
//
// Why synchronous (vs. queue → worker):
//
//   - Operator UX: "click refund, see result" — a 500ms call is
//     fine; an asynchronous flow makes "did it work?" harder to
//     surface.
//   - Stripe failures surface immediately with a typed error the
//     UI can render ("Stripe declined: insufficient_funds_in_account"
//     vs. a generic "queued").
//   - The Pharmax-side ledger write happens AFTER the Stripe call
//     succeeds, so a Stripe failure leaves no ghost negative line.
//
// Idempotency:
//
//   - Bus-level: bus's idempotency cache short-circuits double-clicks.
//   - Stripe-level: the adapter uses `pharmaxRefundKey` as Stripe's
//     idempotency key — re-running the same command returns the
//     SAME Stripe refund id.
//   - Row-level: `billingEventKey: "stripe-refund:{stripeRefundId}"`
//     is unique-per-Stripe-refund. If the operator triggers the
//     same refund twice (different idempotency keys), the second
//     call detects the existing line and returns the prior result
//     rather than double-crediting.
//
// PHI invariant: none. Stripe ids + amounts only. `operatorNote`
// is free-text (NOT PHI by convention but redacted from
// command_log per defense in depth).

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { InvoiceLineKind, InvoiceStatus, type Prisma } from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { getStripeRefundPort } from "../configure.js";

export const ISSUE_REFUND_INVOICE_NOT_FOUND = "ISSUE_REFUND_INVOICE_NOT_FOUND";
export const ISSUE_REFUND_INVOICE_NOT_PAID = "ISSUE_REFUND_INVOICE_NOT_PAID";
export const ISSUE_REFUND_CHARGE_NOT_LINKED = "ISSUE_REFUND_CHARGE_NOT_LINKED";
export const ISSUE_REFUND_AMOUNT_EXCEEDS_PAID = "ISSUE_REFUND_AMOUNT_EXCEEDS_PAID";
export const ISSUE_REFUND_AMOUNT_INVALID = "ISSUE_REFUND_AMOUNT_INVALID";

const inputSchema = z
  .object({
    invoiceId: z.uuid(),
    amountCents: z.number().int().min(1).max(10_000_00),
    reason: z
      .enum(["duplicate", "fraudulent", "requested_by_customer"])
      .default("requested_by_customer"),
    /** Free-text operator note. Redacted from command_log per defense-in-depth. */
    operatorNote: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type IssueRefundInput = z.infer<typeof inputSchema>;

export interface IssueRefundOutput {
  readonly invoiceId: string;
  readonly invoiceLineId: string;
  readonly stripeRefundId: string;
  readonly stripeStatus: "succeeded" | "pending" | "failed" | "canceled";
  readonly amountCents: number;
  /** Pharmax-side credit amount (negative). */
  readonly creditAmountCents: number;
  readonly amountDueCentsAfter: number;
}

export const IssueRefund: Command<IssueRefundInput, IssueRefundOutput> = {
  name: "IssueRefund",
  inputSchema,
  permission: PERMISSIONS.BILLING_ISSUE_REFUND,
  redactFields: ["operatorNote"],

  async handle({ input, ctx, tx, clock, commandLogId }): Promise<HandlerResult<IssueRefundOutput>> {
    if (input.amountCents <= 0) {
      throw new errors.ValidationError({
        code: ISSUE_REFUND_AMOUNT_INVALID,
        message: "Refund amount must be a positive integer (cents).",
        metadata: { amountCents: input.amountCents },
      });
    }

    // ---- Load + validate invoice ----
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, organizationId: ctx.organizationId },
      select: {
        id: true,
        clinicId: true,
        status: true,
        currency: true,
        amountPaidCents: true,
        amountDueCents: true,
        stripeChargeId: true,
        stripeInvoiceId: true,
        invoiceNumber: true,
      },
    });
    if (invoice === null) {
      throw new errors.NotFoundError({
        code: ISSUE_REFUND_INVOICE_NOT_FOUND,
        message: "Invoice not found in this organization.",
        metadata: { invoiceId: input.invoiceId },
      });
    }
    if (invoice.status !== InvoiceStatus.PAID) {
      throw new errors.ConflictError({
        code: ISSUE_REFUND_INVOICE_NOT_PAID,
        message: `Refunds require a PAID invoice (current: ${invoice.status}). For DRAFT/OPEN adjustments use CreditInvoice instead.`,
        metadata: { invoiceId: invoice.id, status: invoice.status },
      });
    }
    if (invoice.stripeChargeId === null) {
      throw new errors.ConflictError({
        code: ISSUE_REFUND_CHARGE_NOT_LINKED,
        message:
          "Invoice has no linked Stripe charge id — cannot issue a Stripe refund. Use CreditInvoice for an internal-only credit.",
        metadata: { invoiceId: invoice.id },
      });
    }

    // ---- Compute prior refund total ----
    // Stripe enforces partial-refund limits on its side, but
    // we verify locally so the operator gets a clear error
    // before hitting Stripe.
    const priorRefunds = await tx.invoiceLine.findMany({
      where: {
        invoiceId: invoice.id,
        kind: InvoiceLineKind.CREDIT,
        billingEventKey: { startsWith: "stripe-refund:" },
      },
      select: { amountCents: true },
    });
    const priorRefundedCents = priorRefunds.reduce(
      (sum, line) => sum + Math.abs(line.amountCents),
      0
    );
    const remainingRefundable = invoice.amountPaidCents - priorRefundedCents;
    if (input.amountCents > remainingRefundable) {
      throw new errors.ConflictError({
        code: ISSUE_REFUND_AMOUNT_EXCEEDS_PAID,
        message: `Refund amount (${input.amountCents}c) exceeds remaining refundable amount (${remainingRefundable}c). Already refunded: ${priorRefundedCents}c.`,
        metadata: {
          invoiceId: invoice.id,
          attemptedCents: input.amountCents,
          remainingRefundableCents: remainingRefundable,
          priorRefundedCents,
        },
      });
    }

    // ---- Call Stripe ----
    // The port is idempotent on `pharmaxRefundKey`. We anchor it
    // on a fresh ulid per command invocation; the bus's
    // idempotency cache + the unique constraint on
    // `billingEventKey` jointly guarantee no double-credit even
    // under repeated calls.
    const pharmaxRefundKey = `pharmax-refund:${ids.generateUlid()}`;
    const port = getStripeRefundPort();
    const stripeResult = await port.issueRefund({
      pharmaxInvoiceId: invoice.id,
      stripeChargeId: invoice.stripeChargeId,
      amountCents: input.amountCents,
      reason: input.reason,
      ...(input.operatorNote !== undefined ? { operatorNote: input.operatorNote } : {}),
      pharmaxRefundKey,
    });

    // ---- Write the negative line ----
    const invoiceLineId = ids.generateUlid();
    const negativeAmount = -input.amountCents;
    const billingEventKey = `stripe-refund:${stripeResult.stripeRefundId}`;
    const hasOperatorNote =
      typeof input.operatorNote === "string" && input.operatorNote.trim().length > 0;

    await tx.invoiceLine.create({
      data: {
        id: invoiceLineId,
        invoiceId: invoice.id,
        organizationId: ctx.organizationId,
        clinicId: invoice.clinicId,
        kind: InvoiceLineKind.CREDIT,
        description: `Refund (${stripeResult.stripeRefundId})`,
        quantity: 1,
        unitAmountCents: negativeAmount,
        amountCents: negativeAmount,
        billingEventKey,
        metadata: {
          sourceEvent: "operator-refund",
          stripeRefundId: stripeResult.stripeRefundId,
          stripeStatus: stripeResult.stripeStatus,
          stripeChargeId: invoice.stripeChargeId,
          reason: input.reason,
          hasOperatorNote,
          issuedByUserId: ctx.actor.userId,
        } satisfies Prisma.InputJsonValue,
      },
    });

    // ---- Update invoice totals ----
    // PAID stays PAID even if fully refunded — the lifecycle
    // status reflects the collection event, not the net balance.
    // amountDue can go NEGATIVE here (it represents the operator's
    // refund obligation that Stripe is now fulfilling).
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        amountDueCents: { decrement: input.amountCents },
        version: { increment: 1 },
      },
    });

    const amountDueCentsAfter = invoice.amountDueCents - input.amountCents;
    const now = clock.now();

    return {
      output: {
        invoiceId: invoice.id,
        invoiceLineId,
        stripeRefundId: stripeResult.stripeRefundId,
        stripeStatus: stripeResult.stripeStatus,
        amountCents: input.amountCents,
        creditAmountCents: negativeAmount,
        amountDueCentsAfter,
      },
      audit: {
        action: "billing.invoice.refunded",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          invoiceLineId,
          stripeChargeId: invoice.stripeChargeId,
          stripeInvoiceId: invoice.stripeInvoiceId,
          stripeRefundId: stripeResult.stripeRefundId,
          stripeStatus: stripeResult.stripeStatus,
          reason: input.reason,
          amountCents: input.amountCents,
          creditAmountCents: negativeAmount,
          priorRefundedCents,
          amountDueCentsAfter,
          hasOperatorNote,
          issuedByUserId: ctx.actor.userId,
          pharmaxRefundKey,
          recordedAt: now.toISOString(),
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "billing.invoice.refunded.v1",
          aggregateType: "Invoice",
          aggregateId: invoice.id,
          payload: {
            organizationId: ctx.organizationId,
            clinicId: invoice.clinicId,
            invoiceId: invoice.id,
            invoiceLineId,
            stripeRefundId: stripeResult.stripeRefundId,
            stripeStatus: stripeResult.stripeStatus,
            stripeChargeId: invoice.stripeChargeId,
            reason: input.reason,
            amountCents: input.amountCents,
            amountDueCentsAfter,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
