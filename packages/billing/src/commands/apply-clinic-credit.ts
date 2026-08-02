// ApplyClinicCredit — settle (part of) an OPEN invoice from the
// clinic's stored credit balance.
//
// Pipeline:
//
//   1. Load + validate the invoice (OPEN only, currency must match
//      the credit balance being spent).
//   2. Lock the clinic row (SELECT … FOR UPDATE) — serializes with
//      GrantClinicCredit and other applications, so the balance
//      read in step 3 is exact and "balance never negative" is a
//      real invariant.
//   3. Read the (clinic, currency) balance; reject if the
//      application exceeds it or exceeds the invoice's remaining
//      balance.
//   4. CAS the invoice (increment amountPaid / decrement amountDue
//      on `version`); flip OPEN → PAID when the credit collects the
//      full remainder.
//   5. Append the payment-ledger row — kind PAYMENT, method
//      CREDIT_BALANCE, key "credit-apply:{ulid}". This is what
//      keeps the nightly reconciler's projection-parity check green:
//      the invoice's amountPaidCents moved, and a ledger PAYMENT row
//      accounts for it. NO NEW CASH arrived — the cash moved when
//      the credit was granted — which is exactly what the
//      CREDIT_BALANCE method communicates to bank-reconciliation
//      views (filter to STRIPE + MANUAL).
//   6. Append the APPLICATION credit entry (same ulid in its key),
//      back-linked to the invoice and the payment row.
//   7. Emit `billing.payment.recorded.v1` +
//      `billing.clinic_credit.recorded.v1` (always), and
//      `billing.invoice.paid.v1` on the PAID flip (its
//      stripeInvoiceId field is nullable for non-Stripe settles).
//
// All of it in ONE transaction: the credit ledger, the payment
// ledger, and the invoice projection can never disagree on a
// partial commit.
//
// Partial applications are first-class: $40 of credit against a
// $100 invoice leaves it OPEN with amountDue=60 and the clinic's
// balance reduced by $40.
//
// Deliberately NOT handled here:
//
//   - Non-OPEN invoices: same posture as RecordManualPayment
//     (DRAFT → finalize first; PAID → nothing to collect; VOID /
//     UNCOLLECTIBLE → explicit decisions required).
//   - Currency conversion: credit is spent in the currency it was
//     granted. A usd balance cannot settle a eur invoice.
//   - Stripe interplay: if the invoice was pushed to Stripe, the
//     operator must void the Stripe-side invoice (surfaced via
//     `stripeInvoiceId` in the audit metadata so the console can
//     warn) — same caveat as manual payments.
//
// Idempotency: bus-level command idempotency key short-circuits
// retries; the shared "credit-apply:{ulid}" key is generated inside
// the handler and commits atomically with the command log.
//
// PHI invariant: none.

import type { Command, HandlerResult, OutboxEventDraft } from "@pharmax/command-bus";
import {
  ClinicCreditEntryKind,
  InvoiceStatus,
  PaymentKind,
  PaymentMethod,
} from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  type ClinicCreditEntryInput,
  clinicCreditRecordedOutboxEvent,
  computeClinicCreditBalanceCents,
  insertClinicCreditEntry,
  lockClinicForCredit,
} from "../credit/clinic-credit.js";
import {
  insertPaymentLedgerRow,
  type PaymentLedgerRowInput,
  paymentRecordedOutboxEvent,
} from "../payments/payment-ledger.js";

export const APPLY_CLINIC_CREDIT_INVOICE_NOT_FOUND = "APPLY_CLINIC_CREDIT_INVOICE_NOT_FOUND";
export const APPLY_CLINIC_CREDIT_INVALID_STATUS = "APPLY_CLINIC_CREDIT_INVALID_STATUS";
export const APPLY_CLINIC_CREDIT_AMOUNT_EXCEEDS_DUE = "APPLY_CLINIC_CREDIT_AMOUNT_EXCEEDS_DUE";
export const APPLY_CLINIC_CREDIT_INSUFFICIENT_BALANCE = "APPLY_CLINIC_CREDIT_INSUFFICIENT_BALANCE";
export const APPLY_CLINIC_CREDIT_VERSION_MISMATCH = "APPLY_CLINIC_CREDIT_VERSION_MISMATCH";

const inputSchema = z
  .object({
    invoiceId: z.uuid(),
    /** Positive cents. Must not exceed the invoice's remaining balance nor the clinic's credit balance. */
    amountCents: z.number().int().min(1).max(100_000_00),
    /** Free-text operator note. Redacted from command_log per defense-in-depth. */
    operatorNote: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type ApplyClinicCreditInput = z.infer<typeof inputSchema>;

export interface ApplyClinicCreditOutput {
  readonly invoiceId: string;
  readonly clinicId: string;
  readonly creditEntryId: string;
  readonly paymentId: string;
  readonly amountCents: number;
  readonly amountPaidCentsAfter: number;
  readonly amountDueCentsAfter: number;
  /** True when this application collected the full remaining balance. */
  readonly fullyPaid: boolean;
  readonly status: InvoiceStatus;
  readonly version: number;
  /** (clinic, currency) credit balance after this application. */
  readonly balanceAfterCents: number;
}

export const ApplyClinicCredit: Command<ApplyClinicCreditInput, ApplyClinicCreditOutput> = {
  name: "ApplyClinicCredit",
  inputSchema,
  permission: PERMISSIONS.BILLING_MANAGE_CLINIC_CREDIT,
  redactFields: ["operatorNote"],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<ApplyClinicCreditOutput>> {
    const now = clock.now();

    // ---- Load + validate invoice ----
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, organizationId: ctx.organizationId },
      select: {
        id: true,
        clinicId: true,
        status: true,
        currency: true,
        totalCents: true,
        amountPaidCents: true,
        amountDueCents: true,
        stripeInvoiceId: true,
        stripeChargeId: true,
        invoiceNumber: true,
        version: true,
      },
    });
    if (invoice === null) {
      throw new errors.NotFoundError({
        code: APPLY_CLINIC_CREDIT_INVOICE_NOT_FOUND,
        message: "Invoice not found in this organization.",
        metadata: { invoiceId: input.invoiceId },
      });
    }

    switch (invoice.status) {
      case InvoiceStatus.OPEN:
        break;
      case InvoiceStatus.DRAFT:
        throw new errors.ConflictError({
          code: APPLY_CLINIC_CREDIT_INVALID_STATUS,
          message:
            "Invoice is still DRAFT — finalize it first (FinalizeInvoice) so the line set is locked before credit is applied against it.",
          metadata: { invoiceId: invoice.id, status: invoice.status },
        });
      case InvoiceStatus.PAID:
        throw new errors.ConflictError({
          code: APPLY_CLINIC_CREDIT_INVALID_STATUS,
          message: "Invoice is already PAID — nothing left to collect.",
          metadata: { invoiceId: invoice.id, status: invoice.status },
        });
      case InvoiceStatus.VOID:
        throw new errors.ConflictError({
          code: APPLY_CLINIC_CREDIT_INVALID_STATUS,
          message: "Invoice is VOID — credit cannot be applied against a voided invoice.",
          metadata: { invoiceId: invoice.id, status: invoice.status },
        });
      case InvoiceStatus.UNCOLLECTIBLE:
        throw new errors.ConflictError({
          code: APPLY_CLINIC_CREDIT_INVALID_STATUS,
          message:
            "Invoice was written off as UNCOLLECTIBLE. Applying credit requires an explicit reopen decision first.",
          metadata: { invoiceId: invoice.id, status: invoice.status },
        });
      default: {
        const _never: never = invoice.status;
        throw new Error(`unhandled InvoiceStatus: ${String(_never)}`);
      }
    }

    if (input.amountCents > invoice.amountDueCents) {
      throw new errors.ConflictError({
        code: APPLY_CLINIC_CREDIT_AMOUNT_EXCEEDS_DUE,
        message: `Credit application (${input.amountCents}c) exceeds the remaining balance (${invoice.amountDueCents}c). Apply at most the remainder; the rest of the credit stays on the clinic's balance.`,
        metadata: {
          invoiceId: invoice.id,
          attemptedCents: input.amountCents,
          amountDueCents: invoice.amountDueCents,
        },
      });
    }

    // ---- Serialize on the clinic row, then check the balance ----
    await lockClinicForCredit(tx, {
      organizationId: ctx.organizationId,
      clinicId: invoice.clinicId,
    });
    const balanceBeforeCents = await computeClinicCreditBalanceCents(tx, {
      organizationId: ctx.organizationId,
      clinicId: invoice.clinicId,
      currency: invoice.currency,
    });
    if (input.amountCents > balanceBeforeCents) {
      throw new errors.ConflictError({
        code: APPLY_CLINIC_CREDIT_INSUFFICIENT_BALANCE,
        message: `Credit application (${input.amountCents}c) exceeds the clinic's ${invoice.currency} credit balance (${balanceBeforeCents}c).`,
        metadata: {
          invoiceId: invoice.id,
          clinicId: invoice.clinicId,
          currency: invoice.currency,
          attemptedCents: input.amountCents,
          balanceCents: balanceBeforeCents,
        },
      });
    }
    const balanceAfterCents = balanceBeforeCents - input.amountCents;

    const amountPaidCentsAfter = invoice.amountPaidCents + input.amountCents;
    const amountDueCentsAfter = invoice.amountDueCents - input.amountCents;
    const fullyPaid = amountDueCentsAfter === 0;
    const nextVersion = invoice.version + 1;

    // ---- CAS update ----
    const updated = await tx.invoice.updateMany({
      where: { id: invoice.id, version: invoice.version },
      data: {
        amountPaidCents: { increment: input.amountCents },
        amountDueCents: { decrement: input.amountCents },
        version: nextVersion,
        ...(fullyPaid ? { status: InvoiceStatus.PAID, paidAt: now } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new errors.ConflictError({
        code: APPLY_CLINIC_CREDIT_VERSION_MISMATCH,
        message:
          "Invoice version was bumped by a concurrent mutation. Re-read the balance and retry.",
        metadata: { invoiceId: invoice.id, attemptedVersion: invoice.version },
      });
    }

    // ---- Payment-ledger row (method CREDIT_BALANCE) ----
    // Shared ulid across both ledger keys so the pair is trivially
    // correlatable in incident forensics.
    const applicationUlid = ids.generateUlid();
    const hasOperatorNote =
      typeof input.operatorNote === "string" && input.operatorNote.trim().length > 0;
    const ledgerRow: PaymentLedgerRowInput = {
      organizationId: ctx.organizationId,
      clinicId: invoice.clinicId,
      invoiceId: invoice.id,
      kind: PaymentKind.PAYMENT,
      method: PaymentMethod.CREDIT_BALANCE,
      amountCents: input.amountCents,
      currency: invoice.currency,
      paymentEventKey: `credit-apply:${applicationUlid}`,
      occurredAt: now,
      metadata: {
        sourceEvent: "clinic-credit-application",
        recordedByUserId: ctx.actor.userId,
        hasOperatorNote,
        commandLogId,
      },
    };
    const ledgerResult = await insertPaymentLedgerRow(tx, ledgerRow);

    // ---- APPLICATION credit entry, back-linked to both rows ----
    const entry: ClinicCreditEntryInput = {
      organizationId: ctx.organizationId,
      clinicId: invoice.clinicId,
      kind: ClinicCreditEntryKind.APPLICATION,
      amountCents: input.amountCents,
      currency: invoice.currency,
      creditEventKey: `credit-apply:${applicationUlid}`,
      appliedToInvoiceId: invoice.id,
      appliedPaymentId: ledgerResult.paymentId,
      occurredAt: now,
      metadata: {
        recordedByUserId: ctx.actor.userId,
        hasOperatorNote,
        commandLogId,
      },
    };
    const entryResult = await insertClinicCreditEntry(tx, entry);

    const outboxEvents: OutboxEventDraft[] = [
      ...(ledgerResult.created
        ? [paymentRecordedOutboxEvent({ paymentId: ledgerResult.paymentId, row: ledgerRow })]
        : []),
      ...(entryResult.created
        ? [
            clinicCreditRecordedOutboxEvent({
              creditEntryId: entryResult.creditEntryId,
              entry,
              balanceAfterCents,
            }),
          ]
        : []),
      ...(fullyPaid
        ? [
            {
              eventType: "billing.invoice.paid.v1",
              aggregateType: "Invoice",
              aggregateId: invoice.id,
              payload: {
                organizationId: ctx.organizationId,
                clinicId: invoice.clinicId,
                invoiceId: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                stripeInvoiceId: invoice.stripeInvoiceId,
                stripeChargeId: invoice.stripeChargeId,
                amountPaidCents: amountPaidCentsAfter,
                totalCents: invoice.totalCents,
                paidAt: now.toISOString(),
                occurredAt: now.toISOString(),
              },
            } satisfies OutboxEventDraft,
          ]
        : []),
    ];

    return {
      output: {
        invoiceId: invoice.id,
        clinicId: invoice.clinicId,
        creditEntryId: entryResult.creditEntryId,
        paymentId: ledgerResult.paymentId,
        amountCents: input.amountCents,
        amountPaidCentsAfter,
        amountDueCentsAfter,
        fullyPaid,
        status: fullyPaid ? InvoiceStatus.PAID : InvoiceStatus.OPEN,
        version: nextVersion,
        balanceAfterCents,
      },
      audit: {
        action: "billing.clinic_credit.applied",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          creditEntryId: entryResult.creditEntryId,
          paymentId: ledgerResult.paymentId,
          amountCents: input.amountCents,
          currency: invoice.currency,
          amountPaidCentsAfter,
          amountDueCentsAfter,
          fullyPaid,
          balanceBeforeCents,
          balanceAfterCents,
          // Non-null means this invoice ALSO lives in Stripe — the
          // operator should void the Stripe-side invoice so the
          // clinic isn't auto-charged for a balance already settled.
          stripeInvoiceId: invoice.stripeInvoiceId,
          hasOperatorNote,
          recordedByUserId: ctx.actor.userId,
          commandLogId,
          occurredAt: now.toISOString(),
        },
      },
      outboxEvents,
    };
  },
};
